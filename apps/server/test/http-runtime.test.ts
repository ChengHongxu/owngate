import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadManifest, loadManifestFile } from '@owngate/connector-runtime';
import { ok, type Connection } from '@owngate/core';
import { SecretRedactor } from '@owngate/vault';
import { RuntimeAuth, type HttpJob } from '@owngate/runtime-http';
import { ConnectorRegistry } from '../src/registry.js';
import { IsolatedHttpRuntime } from '../src/http-runtime.js';

const apps: FastifyInstance[] = [], servers: Server[] = [];
const secret = 'fixture-http-control-' + 'a'.repeat(32), credential = 'fixture-upstream-private-token';
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});
async function listen(server: Server): Promise<string> {
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function fixture(options: {
  path?: string; method?: string; timeout?: number;
  remote?: (job: HttpJob, app: FastifyInstance) => Promise<unknown>;
  upstream?: (request: import('node:http').IncomingMessage, reply: import('node:http').ServerResponse) => void;
} = {}) {
  let hits = 0, capturedAuth = '';
  const base = await listen(createServer((request, reply) => {
    hits++; capturedAuth = request.headers.authorization ?? '';
    if (options.upstream) return options.upstream(request, reply);
    reply.setHeader('content-type', 'application/json'); reply.end(JSON.stringify({ value: 42, echo: credential }));
  }));
  const registry = new ConnectorRegistry();
  registry.register('fixture', loadManifest(JSON.stringify({ connector: 'fixture', version: '1.0.0', title: 'Fixture', access: 'official_api',
    http: { base, headers: { Authorization: 'Bearer {{secret.token}}' }, timeout_ms: options.timeout ?? 1000 },
    capabilities: [{ id: 'fixture.read', kind: 'query', effect: 'read', title: 'Read', cache: null,
      request: { method: options.method ?? 'GET', path: options.path ?? '/balance' }, output: { value: { from: '$.value', type: 'number', sensitivity: 'financial' }, echo: { from: '$.echo', sensitivity: 'content' } } }],
  })));
  const connection: Connection = { id: 'fixture-connection', connector_id: 'fixture', label: 'Fixture', config: {}, capability_states: {}, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
  registry.setCredentials(connection.id, { token: credential });
  const app = Fastify({ logger: false }); apps.push(app);
  let runtimeUrl: string | undefined, captured: HttpJob | undefined;
  if (options.remote) {
    const auth = new RuntimeAuth(secret);
    runtimeUrl = await listen(createServer(async (request, reply) => {
      const buffers: Buffer[] = []; for await (const chunk of request) buffers.push(Buffer.from(chunk));
      const body = Buffer.concat(buffers).toString();
      if (!auth.verify(request.headers, 'POST', '/v1/execute', body)) { reply.writeHead(401); reply.end(); return; }
      captured = JSON.parse(body) as HttpJob;
      const result = await options.remote!(captured, app); reply.setHeader('content-type', 'application/json'); reply.end(JSON.stringify(result));
    }));
  }
  const redactor = new SecretRedactor(); redactor.register(connection.id, [credential]);
  const runtime = new IsolatedHttpRuntime({ registry, getConnection: id => id === connection.id ? connection : undefined, sanitize: value => redactor.redact(value),
    ...(runtimeUrl ? { runtimeUrl, secret, brokerOrigin: 'http://broker.invalid' } : {}),
  });
  await runtime.init(app);
  const capability = registry.getCapability('fixture', 'fixture.read')!;
  const query = () => runtime.dispatch(connection, capability, {});
  return { app, runtime, connection, capability, query, registry, base, get hits() { return hits; }, get capturedAuth() { return capturedAuth; }, get captured() { return captured; } };
}
function endpoint(job: HttpJob) { return new URL(job.broker_url).pathname; }
function result(job: HttpJob) { return ok({ value: 42 }, { connection_id: job.connection.id, connection_label: 'untrusted-label', capability_id: job.capability.id, support: { status: 'supported' } }); }

describe('isolated HTTP credential broker', () => {
  it('executes the actual child, retains credentials in server and sanitizes upstream echoes before IPC', async () => {
    const f = await fixture(); const value = await f.query();
    expect(value).toMatchObject({ outcome: 'success', data: { value: 42, echo: '[REDACTED]' } });
    expect(f.capturedAuth).toBe(`Bearer ${credential}`); expect(f.hits).toBe(1);
    expect(value.fields['value']?.untrusted).toBe(true);
  });
  it('sends no credentials over signed RPC and authorizes only exact method, URL and query', async () => {
    const checked: number[] = []; let usedPath = '';
    const f = await fixture({ remote: async (job, app) => {
      expect(JSON.stringify(job)).not.toContain(credential); expect(job.definition.http.headers).toEqual({});
      usedPath = endpoint(job);
      for (const body of [
        { url: job.definition.http.base + '/private', method: 'GET' },
        { url: job.definition.http.base + '/balance?admin=true', method: 'GET' },
        { url: job.definition.http.base + '/balance', method: 'HEAD' },
        { url: 'http://attacker.invalid/balance', method: 'GET' },
        { url: job.definition.http.base + '/balance', method: 'POST' },
      ]) checked.push((await app.inject({ method: 'POST', url: usedPath, payload: body })).statusCode);
      const permitted = await app.inject({ method: 'POST', url: usedPath, payload: { url: job.definition.http.base + '/balance', method: 'GET' } });
      expect(permitted.statusCode).toBe(200); expect(permitted.body).not.toContain(credential);
      return result(job);
    } });
    const value = await f.query(); expect(value.source.connection_label).toBe('Fixture');
    expect(checked).toEqual([403, 403, 403, 403, 400]); expect(f.hits).toBe(1);
    expect((await f.app.inject({ method: 'POST', url: usedPath, payload: { url: f.base + '/balance', method: 'GET' } })).statusCode).toBe(403);
  });
  it('revokes handles for paused/reconfigured connections, limits uses and rejects unknown handles', async () => {
    const checked: number[] = [];
    const f = await fixture({ remote: async (job, app) => {
      const read = async (path = endpoint(job)) => (await app.inject({ method: 'POST', url: path, payload: { url: job.definition.http.base + '/balance', method: 'GET' } })).statusCode;
      f.connection.paused = true; checked.push(await read()); f.connection.paused = false;
      const revision = f.connection.updated_at; f.connection.updated_at = '2099-01-01T00:00:00Z'; checked.push(await read()); f.connection.updated_at = revision;
      checked.push(await read('/internal/http-runtime/' + '0'.repeat(64)));
      for (let index = 0; index < 13; index++) checked.push(await read());
      return result(job);
    } });
    await f.query(); expect(checked.slice(0, 3)).toEqual([403, 403, 403]);
    expect(checked.slice(3)).toEqual([...Array(12).fill(200), 403]);
    // Paused/revision-rejected attempts do not issue requests or consume valid uses.
    expect(f.hits).toBe(12);
  });
  it('refuses expired handles without sending an upstream request', async () => {
    const f = await fixture({ remote: async (job, app) => {
      const realNow = Date.now; Date.now = () => realNow() + 120_000;
      try { expect((await app.inject({ method: 'POST', url: endpoint(job), payload: { url: job.definition.http.base + '/balance', method: 'GET' } })).statusCode).toBe(403); }
      finally { Date.now = realNow; }
      return result(job);
    } });
    await f.query(); expect(f.hits).toBe(0);
  });
  it('refuses writes, redirects, oversized responses and classifies upstream timeouts', async () => {
    const write = await fixture({ method: 'POST' }); expect((await write.query()).error?.code).toBe('CAPABILITY_DISABLED'); expect(write.hits).toBe(0);
    const redirect = await fixture({ upstream: (_request, reply) => { reply.writeHead(302, { location: 'http://attacker.invalid/token' }); reply.end(); } });
    expect((await redirect.query()).error?.code).toBe('UPSTREAM_ERROR'); expect(redirect.hits).toBe(1);
    const large = await fixture({ upstream: (_request, reply) => { reply.writeHead(200, { 'content-length': String(2 * 1024 * 1024 + 1) }); reply.end('too big'); } });
    expect((await large.query()).error?.code).toBe('UPSTREAM_ERROR');
    const timeout = await fixture({ timeout: 40, upstream: () => undefined });
    expect((await timeout.query()).error?.code).toBe('UPSTREAM_TIMEOUT');
  });
  it('returns missing credentials explicitly and never sends an unauthenticated upstream request', async () => {
    const f = await fixture(); f.registry.clearCredentials(f.connection.id);
    expect((await f.query()).error?.code).toBe('AUTH_MISSING'); expect(f.hits).toBe(0);
  });
  it('runs the compiled TypeScript adapter for three declared pages and keeps the result bounded', async () => {
    const pages: string[] = [];
    const f = await fixture({ upstream: (request, reply) => {
      pages.push(request.url!); reply.setHeader('content-type', 'application/json');
      const page = Number(new URL(request.url!, 'http://fixture').searchParams.get('page'));
      reply.end(JSON.stringify({ items: [{ id: String(page), title: `Page ${page}`, secret: credential }], has_more: true }));
    } });
    const example = loadManifestFile(fileURLToPath(new URL('../../../connectors/paged-json-example/manifest.example.yaml', import.meta.url)));
    f.registry.register(example.id, example); f.connection.connector_id = example.id; f.connection.config = { base_url: f.base };
    f.registry.setCredentials(f.connection.id, { access_token: credential });
    const value = await f.runtime.dispatch(f.connection, example.capabilities['records.list']!, {});
    expect(value.outcome).toBe('success'); expect(value.data).toEqual({ items: [{ id: '1', title: 'Page 1' }, { id: '2', title: 'Page 2' }, { id: '3', title: 'Page 3' }], truncated: true });
    expect(pages).toEqual(['/api/records?page=1', '/api/records?page=2', '/api/records?page=3']);
    expect(value.warnings).toHaveLength(1); expect(JSON.stringify(value)).not.toContain(credential);
  });
});
