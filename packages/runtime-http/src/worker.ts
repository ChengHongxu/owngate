import { dispatchHttp } from './execute.js';
import type { RuntimeRequest, RuntimeResponse } from './types.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ok, err, fail, type ErrorCode, type FieldMeta } from '@owngate/core';
import type { HttpAdapter } from './adapter.js';
import { authorizedHttpReads, resolveHttpUrl } from './request.js';

class BrokerError extends Error {
  constructor(readonly code: ErrorCode) { super('HTTP read could not be authorized or completed'); }
}

process.on('message', (message: RuntimeRequest) => {
  const { job } = message;
  const source = { connection_id: job.connection.id, connection_label: job.connection.label, capability_id: job.capability.id, support: job.connection.capability_states[job.capability.id] ?? job.capability.support };
  let allowed: Set<string>;
  try { allowed = authorizedHttpReads(job.connection, job.capability, job.input, job.definition); }
  catch { process.send?.({ id: message.id, result: fail(err('CAPABILITY_DISABLED', 'Only declared read-only HTTP requests are available'), source) } satisfies RuntimeResponse); return; }
  const brokerFetch: typeof fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (!allowed.has(`${method} ${String(url)}`)) throw new BrokerError('CAPABILITY_DISABLED');
    const response = await fetch(job.broker_url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: String(url), method }), signal: AbortSignal.timeout(Math.max(100, Math.min(job.timeout_ms, 30_000))) });
    if (!response.ok) {
      const error = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      const code = error?.error?.code;
      throw new BrokerError(code === 'AUTH_MISSING' || code === 'GRANT_REVOKED' || code === 'CAPABILITY_DISABLED' || code === 'UPSTREAM_TIMEOUT' ? code : 'UPSTREAM_ERROR');
    }
    const payload = await response.json() as { status: number; body: unknown };
    return new Response(method === 'HEAD' || [204, 205, 304].includes(payload.status) ? null : JSON.stringify(payload.body), { status: payload.status, headers: { 'content-type': 'application/json' } });
  };
  const execute = async () => {
    if (job.definition.request.method !== 'ADAPTER') return dispatchHttp(job.connection, job.capability, job.input, {}, { ...job.definition.http, headers: {} }, job.definition.output, job.definition.success_when, job.definition.auth_failed_when, job.definition.request, job.definition.discovery, brokerFetch);
    if (job.capability.kind !== 'query' || job.capability.effect !== 'read' || !/^[a-zA-Z0-9_-]+$/.test(job.connection.connector_id)) return fail(err('CAPABILITY_DISABLED', 'Code adapter is not available'), source);
    const file = resolve(fileURLToPath(new URL('../../../connectors/', import.meta.url)), job.connection.connector_id, 'adapter.mjs');
    const adapter = (await import(pathToFileURL(file).href) as { default: HttpAdapter }).default;
    if (!adapter || typeof adapter.run !== 'function') throw new Error('Invalid adapter export');
    const logs: string[] = [];
    const result = await adapter.run(job.capability.id, job.input, {
      http: { get: async (path) => {
        const url = resolveHttpUrl(job.connection, job.capability, job.input, job.definition.http, path);
        const response = await brokerFetch(url, { method: 'GET' }); const text = await response.text();
        let json: unknown = null; try { json = JSON.parse(text); } catch { /* caller can inspect text */ }
        return { status: response.status, json, text };
      } },
      browser: undefined,
      log: (message) => { if (typeof message === 'string' && logs.length < 10) logs.push(message.slice(0, 200)); },
      signal: AbortSignal.timeout(job.timeout_ms),
    });
    const properties = job.capability.output['properties'] as Record<string, Record<string, unknown>> | undefined;
    const fields: Record<string, FieldMeta> = {};
    for (const [key, schema] of Object.entries(properties ?? {})) {
      const value = (result as Record<string, unknown> | null)?.[key];
      fields[key] = { status: value === null || value === undefined ? 'unknown' : 'ok', untrusted: true,
        ...(typeof schema['x-unit'] === 'string' ? { unit: schema['x-unit'] } : {}),
        ...(typeof schema['x-scope'] === 'string' ? { scope: schema['x-scope'] } : {}),
        ...(['pii', 'financial', 'content'].includes(String(schema['x-sensitivity'])) ? { sensitivity: schema['x-sensitivity'] as NonNullable<FieldMeta['sensitivity']> } : {}),
      };
    }
    const envelope = ok(result, source, { warnings: logs, fields });
    if (Object.values(fields).some(field => field.status === 'unknown')) { envelope.outcome = 'partial'; envelope.status = 'partial'; }
    return envelope;
  };
  void execute()
    .then((result) => { process.send?.({ id: message.id, result } satisfies RuntimeResponse); })
    .catch((error: unknown) => { process.send?.(error instanceof BrokerError
      ? { id: message.id, result: fail(err(error.code, error.message), source) } satisfies RuntimeResponse
      : { id: message.id, error: 'CONNECTOR_CRASHED' } satisfies RuntimeResponse); });
});
process.on('disconnect', () => process.exit(0));
