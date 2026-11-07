import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { err, fail, type Connection, type Capability, type ResultEnvelope, type ExecutionEvent } from '@owngate/core';
import { defaultInput, renderTemplate } from '@owngate/connector-runtime';
import { HttpRuntimeHost, signRuntime, authorizedHttpReads, type HttpJob, type HttpDefinition } from '@owngate/runtime-http';
import type { ConnectorRegistry } from './registry.js';
import { executionRecorder } from './execution-trace.js';

interface Handle { connection: Connection; revision: string; capability: Capability; input: unknown; definition: HttpDefinition; expiresAt: number; origin: string; reads: Set<string>; uses: number; abort: AbortController; diagnostics?: (event: ExecutionEvent) => void }
const MAX_READS = 12;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

async function readResponse(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) { await response.body?.cancel(); throw new Error('Response exceeds limit'); }
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  if (reader) while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) { await reader.cancel(); throw new Error('Response exceeds limit'); }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export class IsolatedHttpRuntime {
  private handles = new Map<string, Handle>();
  private local = new HttpRuntimeHost();
  private brokerOrigin: string | undefined;
  constructor(private readonly options: { registry: ConnectorRegistry; getConnection: (id: string) => Connection | undefined; runtimeUrl?: string; secret?: string; brokerOrigin?: string; sanitize: (data: unknown) => unknown }) {}
  async init(app: FastifyInstance) {
    // Opaque short-lived handles are credentials: never log route URLs or
    // request bodies, and never expose this endpoint through the LAN reverse proxy.
    app.post<{ Params: { handle: string }; Body: { url: string; method: string } }>('/internal/http-runtime/:handle', { logLevel: 'silent', schema: { body: { type: 'object', additionalProperties: false, required: ['url', 'method'], properties: { url: { type: 'string', maxLength: 8000 }, method: { type: 'string', enum: ['GET', 'HEAD'] } } } } }, async (request, reply) => {
      const handle = this.handles.get(request.params.handle), current = handle && this.options.getConnection(handle.connection.id);
      if (!handle || handle.expiresAt <= Date.now() || !current || current.paused || current.updated_at !== handle.revision || ++handle.uses > MAX_READS) return reply.status(403).send({ error: { code: 'GRANT_REVOKED', message: 'Request handle is unavailable' } });
      let url: URL;
      try { url = new URL(request.body.url); if (url.origin !== handle.origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid origin'); }
      catch { return reply.status(403).send({ error: { code: 'CAPABILITY_DISABLED', message: 'Request handle does not permit this URL' } }); }
      if (!handle.reads.has(`${request.body.method} ${url.href}`)) return reply.status(403).send({ error: { code: 'CAPABILITY_DISABLED', message: 'Request handle does not permit this URL' } });
      const credential = this.options.registry.getCredentials(current.id) ?? {}, context = { config: current.config, secret: credential, input: defaultInput(handle.input, handle.capability.input) };
      const headers: Record<string, string> = {};
      for (const [name, template] of Object.entries(handle.definition.http.headers ?? {})) {
        const rendered = renderTemplate(template, context);
        if (rendered.warnings.length) return reply.status(403).send({ error: { code: 'AUTH_MISSING', message: 'Required credential is missing' } });
        headers[name] = rendered.value;
      }
      const started = performance.now(), stepId = `http.request_${handle.uses}`;
      handle.diagnostics?.({ type: 'start', id: stepId, label: '读取站点接口响应' });
      try {
        const response = await fetch(url, { method: request.body.method, headers, redirect: 'error', signal: AbortSignal.any([handle.abort.signal, AbortSignal.timeout(Math.min(30_000, Math.max(1, handle.expiresAt - Date.now()), handle.definition.http.timeout_ms ?? 10_000))]) });
        const text = await readResponse(response, MAX_RESPONSE_BYTES); let body: unknown = text;
        try { body = JSON.parse(text); } catch { /* Some APIs legitimately return text. */ }
        handle.diagnostics?.({ type: 'finish', id: stepId, label: '读取站点接口响应', status: response.ok ? 'success' : 'error',
          duration_ms: Math.max(0, performance.now() - started), detail: `${request.body.method} · HTTP ${response.status}`,
          ...(!response.ok ? { code: `HTTP_${response.status}` } : {}) });
        return { status: response.status, body: this.options.sanitize(body) };
      } catch (error) {
        const code = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR';
        handle.diagnostics?.({ type: 'finish', id: stepId, label: '读取站点接口响应', status: 'error',
          duration_ms: Math.max(0, performance.now() - started), detail: '站点请求未完成或响应超过读取限制', code });
        return reply.status(502).send({ error: { code, message: 'Upstream HTTP request failed' } });
      }
    });
    // inject() tests have no listening port; use the same broker route through
    // app.inject while the child communicates over a private loopback listener.
    if (!this.options.runtimeUrl) {
      const { createServer } = await import('node:http');
      const broker = createServer(async (request, response) => {
        if (request.method !== 'POST' || !/^\/internal\/http-runtime\/[a-f0-9]{64}$/.test(request.url ?? '')) { response.writeHead(404); response.end(); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const raw of request) { const chunk = Buffer.from(raw); size += chunk.length; if (size > 16_384) { response.writeHead(413); response.end(); return; } chunks.push(chunk); }
        const result = await app.inject({ method: 'POST', url: request.url ?? '/', headers: { 'content-type': 'application/json' }, payload: Buffer.concat(chunks).toString('utf8') });
        response.writeHead(result.statusCode, { 'content-type': 'application/json' }); response.end(result.body);
      });
      broker.requestTimeout = 35_000; broker.headersTimeout = 5000;
      await new Promise<void>((resolve) => broker.listen(0, '127.0.0.1', resolve));
      this.brokerOrigin = `http://127.0.0.1:${(broker.address() as { port: number }).port}`;
      app.addHook('onClose', async () => { for (const handle of this.handles.values()) handle.abort.abort(); this.handles.clear(); await this.local.close(); broker.closeAllConnections(); await new Promise<void>((resolve) => broker.close(() => resolve())); });
    } else {
      if (!this.options.secret || this.options.secret.length < 32 || !this.options.brokerOrigin) throw new Error('Production HTTP runtime requires a secret and explicit broker origin');
      const broker = new URL(this.options.brokerOrigin), runtime = new URL(this.options.runtimeUrl);
      if (![broker, runtime].every(url => ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash)) throw new Error('HTTP runtime and broker must use explicit HTTP origins');
      this.brokerOrigin = broker.origin;
      app.addHook('onClose', async () => { for (const handle of this.handles.values()) handle.abort.abort(); this.handles.clear(); });
    }
  }
  async dispatch(connection: Connection, capability: Capability, input: unknown): Promise<ResultEnvelope> {
    const source = { connection_id: connection.id, connection_label: connection.label, capability_id: capability.id, support: connection.capability_states[capability.id] ?? capability.support };
    const manifest = this.options.registry.getManifest(connection.connector_id), capDef = manifest?.capabilityDefs[capability.id];
    if (!manifest?.http || !capDef?.request || !this.brokerOrigin) return fail(err('CAPABILITY_UNSUPPORTED', 'This connector has no HTTP implementation'), source);
    if (capability.kind !== 'query' || capability.effect !== 'read' || !['GET', 'HEAD', 'ADAPTER'].includes(capDef.request.method)) return fail(err('CAPABILITY_DISABLED', 'Only read-only HTTP requests are available'), source);
    const rendered = renderTemplate(manifest.http.base, { config: connection.config, secret: {}, input: defaultInput(input, capability.input) });
    let origin: string;
    try { const url = new URL(rendered.value); if (rendered.warnings.length || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid origin'); origin = url.origin; }
    catch { return fail(err('INVALID_PARAMS', 'Invalid HTTP site origin'), source); }
    const timeout = Math.min(60_000, Math.max(1000, (manifest.http.timeout_ms ?? 10_000) * 2 + 3000)), id = randomBytes(32).toString('hex');
    const definition: HttpDefinition = { http: manifest.http, request: capDef.request, ...(capDef.output ? { output: capDef.output } : {}), ...(capDef.success_when ? { success_when: capDef.success_when } : {}), ...(capDef.auth_failed_when ? { auth_failed_when: capDef.auth_failed_when } : {}), ...(manifest.compiled.discovery ? { discovery: manifest.compiled.discovery } : {}) };
    let reads: Set<string>;
    try { reads = authorizedHttpReads(connection, capability, input, definition); }
    catch { return fail(err('INVALID_PARAMS', 'Invalid declared HTTP read path'), source); }
    if (this.handles.size >= 256) return fail(err('RATE_LIMITED', 'Too many HTTP queries are running; retry later'), source);
    const abort = new AbortController();
    const diagnostics = executionRecorder();
    this.handles.set(id, { connection, capability, input, definition, origin, reads, revision: connection.updated_at, expiresAt: Date.now() + timeout, uses: 0, abort,
      ...(diagnostics ? { diagnostics } : {}) });
    const job: HttpJob = { connection: structuredClone(connection), capability, input, definition: { ...definition, http: { ...definition.http, headers: {} } }, broker_url: `${this.brokerOrigin.replace(/\/$/, '')}/internal/http-runtime/${id}`, timeout_ms: timeout };
    try {
      if (!this.options.runtimeUrl) return { ...await this.local.execute(job), source };
      const url = new URL('/v1/execute', this.options.runtimeUrl), body = JSON.stringify(job);
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...signRuntime(this.options.secret!, 'POST', url.pathname, body) }, body, signal: AbortSignal.timeout(timeout + 1000) });
      if (!response.ok) { const error = await response.json().catch(() => null) as { code?: string } | null; throw new Error(error?.code ?? 'CONNECTOR_CRASHED'); }
      const result = JSON.parse(await readResponse(response, MAX_RESPONSE_BYTES * 2)) as ResultEnvelope;
      if (!['success', 'partial', 'error'].includes(result.outcome)) throw new Error('CONNECTOR_CRASHED');
      return { ...result, source };
    } catch (error) { return fail(err(error instanceof Error && (error.message === 'UPSTREAM_TIMEOUT' || error.name === 'TimeoutError') ? 'UPSTREAM_TIMEOUT' : 'CONNECTOR_CRASHED', 'HTTP connector did not complete; check this connection or retry later'), source); }
    finally { abort.abort(); this.handles.delete(id); }
  }
}
