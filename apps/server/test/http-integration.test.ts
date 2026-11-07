// Exercise the production manifests through real HTTP, MCP and a CLI process.
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Grant, ResultEnvelope } from '@owngate/core';
import { buildServer } from '../src/main.js';
import { adminWithStepUp, tempDbPath } from './helpers/admin.js';
import type { AdminSession } from './helpers/admin.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TOKEN = 'fixture-upstream-access-token';
let upstream: Server;
let baseUrl: string;
let app: FastifyInstance;
let admin: AdminSession;
let server: Awaited<ReturnType<typeof buildServer>>;
let connectionId: string;
let client: { id: string; token: string };
let ratio: number | undefined = 250000;
let requests = 0;
let configDir: string;
const fixtureDb = tempDbPath('owngate-http-integration-');

async function createClient(visibility?: Grant['visibility']) {
  const response = await app.inject({ method: 'POST', url: '/admin/clients', headers: admin.headers, payload: { label: 'Fixture client' } });
  expect(response.statusCode).toBe(201);
  expect(response.json()).not.toHaveProperty('kind');
  const created = response.json() as { id: string; token: string };
  await app.inject({ method: 'POST', url: '/admin/grants', headers: admin.headers,
    payload: { client_id: created.id, connection_id: connectionId, capabilities: ['account.balance'], ...(visibility ? { visibility } : {}) } });
  return created;
}

async function query(token: string, noCache = false) {
  return app.inject({ method: 'POST', url: '/api/invoke', headers: { authorization: `Bearer ${token}` },
    payload: { connection_id: connectionId, capability_id: 'account.balance', no_cache: noCache } });
}

async function mcpQuery(token: string) {
  const response = await app.inject({ method: 'POST', url: '/mcp', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
  }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'query', arguments: {
    connection_id: connectionId, capability_id: 'account.balance', no_cache: true,
  } } } });
  const data = response.body.split('\n').find((line) => line.startsWith('data:'));
  expect(response.statusCode).toBe(200);
  const rpc = data ? JSON.parse(data.slice(5).trim()) : response.json();
  return JSON.parse(rpc.result.content[0].text) as ResultEnvelope;
}

async function cliQuery(extra: string[] = []) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve(ROOT, 'apps/cli/dist/bin.js'), 'query', connectionId, 'account.balance', '--json', '--no-cache', ...extra], {
      env: { ...process.env, OWNGATE_CONFIG_DIR: configDir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI did not finish within 5 seconds')); }, 5000);
    child.stdout.on('data', (data) => { stdout += String(data); });
    child.stderr.on('data', (data) => { stderr += String(data); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
  });
}

beforeAll(async () => {
  upstream = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/status') return response.end(JSON.stringify({ success: true, data: ratio === undefined ? {} : { quota_per_unit: ratio } }));
    requests++;
    if (request.headers.authorization !== `Bearer ${TOKEN}` || request.headers['new-api-user'] !== '42') {
      response.statusCode = 401;
      return response.end(JSON.stringify({ success: false }));
    }
    response.end(JSON.stringify({ success: true, data: { quota: 1000000, username: 'Fixture User', email: 'fixture@example.invalid' } }));
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  server = await buildServer({ dbPath: fixtureDb.path }); app = server.app;
  admin = await adminWithStepUp(app);
  const created = await app.inject({ method: 'POST', url: '/admin/connections', headers: admin.headers,
    payload: { connector_id: 'newapi', label: 'Fixture API', config: { base_url: baseUrl, user_id: '42' } } });
  expect(created.statusCode).toBe(201); connectionId = created.json().id;
  const saved = await app.inject({ method: 'PUT', url: `/admin/connections/${connectionId}/credentials`, headers: admin.headers,
    payload: { credentials: { access_token: TOKEN } } });
  expect(saved.statusCode).toBe(200); expect(saved.json().verified).toBe(true);
  expect(saved.json().capability_states['account.balance'].status).toBe('supported');
  client = await createClient({ pii: true });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  configDir = mkdtempSync(join(tmpdir(), 'owngate-cli-integration-'));
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ server: address, token: client.token }), { mode: 0o600 });
});

afterAll(async () => {
  await app?.close();
  if (upstream) await new Promise<void>((done) => upstream.close(() => done()));
  fixtureDb.cleanup();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

describe('production HTTP manifest integration', () => {
  it('Web, REST, MCP and the actual CLI return the same authorized business data', async () => {
    const rest = (await query(client.token, true)).json() as ResultEnvelope;
    expect(rest.outcome).toBe('success'); expect(rest.data).toEqual({ quota: 4, username: 'Fixture User', email: 'fixture@example.invalid' });
    const web = await app.inject({ method: 'POST', url: '/admin/invoke', headers: admin.headers,
      payload: { connection_id: connectionId, capability_id: 'account.balance', no_cache: true } });
    expect(web.json().data).toEqual(rest.data);
    expect(web.json().execution?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'transport.http', status: 'success' }),
      expect.objectContaining({ id: 'http.request_1', status: 'success', detail: 'GET · HTTP 200' }),
    ]));
    expect(JSON.stringify(web.json().execution)).not.toContain(TOKEN);
    expect(JSON.stringify(web.json().execution)).not.toContain(baseUrl);
    expect(rest).not.toHaveProperty('execution');
    const mcp = await mcpQuery(client.token);
    expect(mcp.data).toEqual(rest.data);
    expect(mcp).not.toHaveProperty('execution');
    const cli = await cliQuery(); expect(cli.stderr).toBe(''); expect(cli.code).toBe(0);
    expect(JSON.parse(cli.stdout).data).toEqual(rest.data);
    expect(requests).toBeGreaterThanOrEqual(5); // Includes credential verification, no pong branch.
  });

  it('filters the encrypted shared cache using explicit visibility and uniform client defaults', async () => {
    await app.inject({ method: 'POST', url: '/admin/invoke', headers: admin.headers,
      payload: { connection_id: connectionId, capability_id: 'account.balance' } });
    const restricted = await createClient();
    const before = requests;
    const result = (await query(restricted.token)).json() as ResultEnvelope;
    expect(result.cache?.hit).toBe(true); expect(requests).toBe(before);
    expect(result.data).toEqual({ quota: 4, username: null, email: null });
    expect(result.fields['username']?.status).toBe('redacted');
    const rows = await server.db.rawQuery('SELECT ciphertext FROM results_cache');
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('Fixture User');
  });

  it('applies visibility changes to the same token through REST, MCP and the actual CLI', async () => {
    const setVisibility = (visibility: Grant['visibility']) => app.inject({ method: 'POST', url: '/admin/grants', headers: admin.headers,
      payload: { client_id: client.id, connection_id: connectionId, capabilities: ['account.balance'], visibility } });
    try {
      expect((await setVisibility({ pii: false, financial: false, content: true })).statusCode).toBe(201);
      const hidden = (await query(client.token)).json() as ResultEnvelope;
      expect(hidden.data).toEqual({ quota: null, username: null, email: null });
      expect(hidden.fields['quota']?.status).toBe('redacted');
      expect((await mcpQuery(client.token)).data).toEqual(hidden.data);
      const cli = await cliQuery(); expect(cli.code).toBe(0); expect(cli.stderr).toBe('');
      expect(JSON.parse(cli.stdout).data).toEqual(hidden.data);
      const adminResult = await app.inject({ method: 'POST', url: '/admin/invoke', headers: admin.headers,
        payload: { connection_id: connectionId, capability_id: 'account.balance' } });
      expect(adminResult.json().data).toEqual({ quota: 4, username: 'Fixture User', email: 'fixture@example.invalid' });
      expect((await setVisibility({ pii: true, financial: true, content: true })).statusCode).toBe(201);
      const visible = (await query(client.token)).json() as ResultEnvelope;
      expect(visible.data).toEqual(adminResult.json().data);
      expect((await mcpQuery(client.token)).data).toEqual(visible.data);
      expect(JSON.parse((await cliQuery()).stdout).data).toEqual(visible.data);
    } finally { await setVisibility({ pii: true, financial: true, content: true }); }
  });

  it('only returns the newly issued token once and refuses grants for a revoked client', async () => {
    const response = await app.inject({ method: 'POST', url: '/admin/clients', headers: admin.headers,
      payload: { label: 'One-time fixture' } });
    const issued = response.json() as { id: string; token: string };
    expect(response.statusCode).toBe(201);
    expect(issued.token).toMatch(/^[a-f0-9]{64}$/);
    expect(issued).not.toHaveProperty('kind');
    expect(issued).not.toHaveProperty('token_hash');
    const listing = await app.inject({ method: 'GET', url: '/admin/clients', headers: admin.headers });
    expect(listing.body).not.toContain(issued.token);
    expect(listing.body).not.toContain('token_hash');
    expect(listing.json().clients.every((item: Record<string, unknown>) => !Object.hasOwn(item, 'kind'))).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/session', headers: { authorization: `Bearer ${issued.token}` } })).json()).toEqual({ id: issued.id, label: 'One-time fixture' });
    await app.inject({ method: 'POST', url: `/admin/clients/${issued.id}/revoke`, headers: admin.headers });
    const denied = await app.inject({ method: 'POST', url: '/admin/grants', headers: admin.headers,
      payload: { client_id: issued.id, connection_id: connectionId, capabilities: ['account.balance'] } });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().code).toBe('CLIENT_REVOKED');
    expect((await query(issued.token)).json().error.code).toBe('CLIENT_REVOKED');
  });

  it('keeps configuration outside the vault and discards credentials when the destination changes', async () => {
    const created = await app.inject({ method: 'POST', url: '/admin/connections', headers: admin.headers,
      payload: { connector_id: 'newapi', label: 'Editable fixture', config: { base_url: baseUrl, user_id: '42' } } });
    const id = created.json().id as string;
    expect(created.statusCode).toBe(201);
    await app.inject({ method: 'PUT', url: `/admin/connections/${id}/credentials`, headers: admin.headers,
      payload: { credentials: { access_token: TOKEN } } });
    const updated = await app.inject({ method: 'PATCH', url: `/admin/connections/${id}`, headers: admin.headers,
      payload: { label: 'Renamed fixture', config: { base_url: baseUrl, user_id: '43' } } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ label: 'Renamed fixture', config: { user_id: '43' }, capability_states: { 'account.balance': { status: 'unverified' } } });
    expect((await server.db.listCredentials(id)).map((row) => row.key)).toEqual(['access_token']);
    const destination = new URL(baseUrl); destination.hostname = 'localhost';
    const moved = await app.inject({ method: 'PATCH', url: `/admin/connections/${id}`, headers: admin.headers,
      payload: { config: { base_url: destination.href, user_id: '43' } } });
    expect(moved.statusCode).toBe(200);
    expect(await server.db.listCredentials(id)).toEqual([]);
    expect(server.connectorRegistry.getCredentials(id)).toBeUndefined();
    const before = requests;
    const denied = await app.inject({ method: 'POST', url: '/admin/invoke', headers: admin.headers,
      payload: { connection_id: id, capability_id: 'account.balance' } });
    expect(denied.json().error.code).toBe('AUTH_MISSING');
    expect(requests).toBe(before);
    await app.inject({ method: 'DELETE', url: `/admin/connections/${id}`, headers: admin.headers });
  });

  it('preserves a rejected input envelope and its usage exit code in the CLI', async () => {
    const cli = await cliQuery(['--param', 'unexpected=value']);
    expect(cli.code).toBe(2); expect(cli.stderr).toContain('schema');
    expect(cli.stderr).not.toContain('unexpected=value');
    expect(JSON.parse(cli.stdout).error.code).toBe('INVALID_PARAMS');
  });

  it('keeps raw quota and declares its unit when the site omits a conversion ratio', async () => {
    ratio = undefined;
    try {
      const result = (await query(client.token, true)).json() as ResultEnvelope;
      expect(result.data).toMatchObject({ quota: 1000000 });
      expect(result.fields['quota']?.unit).toBe('quota');
      expect(result.warnings.length).toBeGreaterThan(0);
    } finally { ratio = 250000; }
  });

  it('rejects every action through the admin entry point before making an upstream request', async () => {
    const cap = server.connectorRegistry.getCapability('newapi', 'account.balance')!;
    const existing = server.connectorRegistry.getManifest('newapi')!.compiled;
    server.connectorRegistry.register('newapi', { ...existing, capabilities: { ...existing.capabilities,
      'account.write': { ...cap, id: 'account.write', kind: 'action', effect: 'write', cache: null } } });
    const before = requests;
    const response = await app.inject({ method: 'POST', url: '/admin/invoke', headers: admin.headers,
      payload: { connection_id: connectionId, capability_id: 'account.write' } });
    expect(response.json().error.code).toBe('CAPABILITY_DISABLED'); expect(requests).toBe(before);
  });

  it('keeps rejected credentials blocked until new credentials actually verify', async () => {
    const invalid = await app.inject({ method: 'PUT', url: `/admin/connections/${connectionId}/credentials`, headers: admin.headers,
      payload: { credentials: { access_token: 'fixture-rejected-token' } } });
    expect(invalid.statusCode).toBe(200); expect(invalid.json().verified).toBe(false);
    expect(invalid.json().capability_states['account.balance'].status).toBe('needs_auth');
    expect((await query(client.token)).json().error.code).toBe('AUTH_EXPIRED');
    const rows = await server.db.listConnections();
    expect((rows.find((row) => row.id === connectionId)?.capability_states as Record<string, { status: string }>)['account.balance']?.status).toBe('needs_auth');
    const restored = await app.inject({ method: 'PUT', url: `/admin/connections/${connectionId}/credentials`, headers: admin.headers,
      payload: { credentials: { access_token: TOKEN } } });
    expect(restored.json().verified).toBe(true);
  });

  it('preserves credentials and verified states across restart, then enforces grant revocation', async () => {
    await app.close();
    server = await buildServer({ dbPath: fixtureDb.path }); app = server.app;
    admin = await adminWithStepUp(app, admin.totpSecret);
    expect(server.services.connections.get(connectionId)?.capability_states['account.balance']?.status).toBe('supported');
    const restored = (await query(client.token, true)).json();
    expect(restored.data).toEqual({ quota: 4, username: 'Fixture User', email: 'fixture@example.invalid' });
    expect((await mcpQuery(client.token)).data).toEqual(restored.data);
    expect(server.services.auth.getClientById!(client.id)).not.toHaveProperty('kind');
    expect(server.services.auth.getGrants(client.id)[0]?.visibility).toEqual({ pii: true, financial: true, content: true });
    await app.inject({ method: 'POST', url: '/admin/grants', headers: admin.headers,
      payload: { client_id: client.id, connection_id: connectionId, capabilities: [] } });
    const denied = await query(client.token); expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('PERMISSION_DENIED');
    const listing = await app.inject({ method: 'GET', url: '/api/connections', headers: { authorization: `Bearer ${client.token}` } });
    expect(listing.json().connections).toEqual([]);
    const capabilities = await app.inject({ method: 'GET', url: `/api/connections/${connectionId}/capabilities`, headers: { authorization: `Bearer ${client.token}` } });
    expect(capabilities.statusCode).toBe(404);
  });
});
