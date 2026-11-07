import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok, fail, err, type Capability, type ResultEnvelope } from '@owngate/core';
import { buildServer } from '../src/main.js';
import type { BrowserClient } from '../src/browser-client.js';
import { adminWithStepUp, tempDbPath } from './helpers/admin.js';
import { filterFeedSince } from '../src/queries.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
const capability: Capability = { id: 'account.balance', title: 'Fixture balance', description: 'Fixture', kind: 'query', effect: 'read', approval: 'never', transport: 'http', input: { type: 'object', additionalProperties: false }, output: { type: 'object', additionalProperties: false, properties: {
  name: { type: 'string', 'x-sensitivity': 'pii' }, balance: { type: 'number', 'x-sensitivity': 'financial' }, note: { type: 'string', 'x-sensitivity': 'content' },
} }, cache: { ttl: 300 }, long_running: false, cancel: 'local_only', idempotency: 'none', verify: null, support: { status: 'supported' } };
async function fixture() {
  const temp = tempDbPath('owngate-product-'), closeSession = vi.fn(async () => ({ ok: true })), resumeSafety = vi.fn(async () => ({ ok: true }));
  const dispatch = vi.fn(async (connection, cap) => {
    const source = { connection_id: connection.id, connection_label: connection.label, capability_id: cap.id, support: { status: 'supported' as const } };
    return connection.label === 'Failed' ? fail(err('UPSTREAM_ERROR', 'Fixture outage'), source) : ok({ name: 'Private Name', balance: 0, note: 'Fixture content' }, source);
  });
  const server = await buildServer({ dbPath: temp.path, dispatcher: { dispatch }, browserClient: { closeSession, resumeSafety } as unknown as BrowserClient });
  const admin = await adminWithStepUp(server.app);
  server.connectorRegistry.register('product-fixture', { id: 'product-fixture', title: 'Fixture', version: '1', transport: 'http', capabilities: { [capability.id]: capability } });
  closers.push(async () => { await server.app.close(); temp.cleanup(); });
  async function connection(label = 'Personal', organization = false) {
    const created = await server.app.inject({ method: 'POST', url: '/admin/connections', headers: admin.headers, payload: { connector_id: 'product-fixture', label, config: {}, ...(organization ? { scope: 'organization', confirm_organization: true } : {}) } });
    expect(created.statusCode).toBe(201); const c = created.json() as { id: string };
    await server.app.inject({ method: 'POST', url: `/admin/connections/${c.id}/verify`, headers: admin.headers });
    return c.id;
  }
  async function client(id: string) {
    const created = await server.app.inject({ method: 'POST', url: '/admin/clients', headers: admin.headers, payload: { label: 'Fixture AI', expires_at: new Date(Date.now() + 86_400_000).toISOString() } });
    const c = created.json() as { id: string; token: string };
    await grant(c.id, id, {}); return c;
  }
  async function grant(client_id: string, connection_id: string, visibility: Record<string, boolean>, capabilities = ['account.balance']) {
    const result = await server.app.inject({ method: 'POST', url: '/admin/grants', headers: admin.headers, payload: { client_id, connection_id, capabilities, visibility } });
    expect(result.statusCode).toBe(201);
  }
  return { ...server, temp, admin, connection, client, grant, dispatch, closeSession, resumeSafety };
}

describe('product integration', () => {
  it('requires an explicit organization confirmation and excludes it from automatic queries', async () => {
    const f = await fixture(), id = await f.connection(), org = await f.connection('Organization', true), client = await f.client(id);
    const invalid = await f.app.inject({ method: 'POST', url: '/admin/connections', headers: f.admin.headers, payload: { connector_id: 'product-fixture', label: 'Unconfirmed', config: {}, scope: 'organization' } });
    expect(invalid.statusCode).toBe(400);
    await f.grant(client.id, org, {});
    const all = await f.app.inject({ method: 'POST', url: '/api/query', headers: { authorization: `Bearer ${client.token}` }, payload: { capability_id: capability.id } });
    expect(all.json().results.map((r: ResultEnvelope) => r.source.connection_id)).toEqual([id]);
    const explicit = await f.app.inject({ method: 'POST', url: '/api/query', headers: { authorization: `Bearer ${client.token}` }, payload: { capability_id: capability.id, connection_ids: [org] } });
    expect(explicit.json().results[0].source.connection_id).toBe(org);
  });
  it('keeps per-source failures and reports partial without hiding the good source', async () => {
    const f = await fixture(), good = await f.connection(), bad = await f.connection('Failed');
    const c = f.services.connections.get(bad)!; c.capability_states[capability.id] = { status: 'supported' };
    const response = await f.app.inject({ method: 'POST', url: '/admin/query', headers: f.admin.headers, payload: { capability_id: capability.id, connection_ids: [good, bad], no_cache: true } });
    expect(response.json()).toMatchObject({ status: 'partial', results: [{ outcome: 'success', data: { balance: 0 } }, { outcome: 'error', error: { code: 'UPSTREAM_ERROR' } }] });
  });
  it('uses current field visibility for a shared encrypted cache, including zero values', async () => {
    const f = await fixture(), id = await f.connection(), client = await f.client(id);
    const query = () => f.app.inject({ method: 'POST', url: '/api/invoke', headers: { authorization: `Bearer ${client.token}` }, payload: { connection_id: id, capability_id: capability.id } });
    expect((await query()).json().data).toEqual({ name: null, balance: 0, note: 'Fixture content' });
    await f.grant(client.id, id, { pii: true, financial: false, content: false }); const before = f.dispatch.mock.calls.length;
    const updated = (await query()).json();
    expect(updated.cache.hit).toBe(true); expect(f.dispatch.mock.calls.length).toBe(before);
    expect(updated.data).toEqual({ name: 'Private Name', balance: null, note: null });
    expect(updated.fields.balance.status).toBe('redacted');
    expect(JSON.stringify(await f.db.rawQuery('SELECT * FROM results_cache'))).not.toContain('Private Name');
  });
  it('expires all client entry points and cannot read a previous task after expiry', async () => {
    const f = await fixture(), id = await f.connection(), client = await f.client(id);
    const queued = await f.app.inject({ method: 'POST', url: '/api/tasks', headers: { authorization: `Bearer ${client.token}` }, payload: { connection_id: id, capability_id: capability.id } });
    expect(queued.statusCode).toBe(202);
    f.services.auth.getClientById!(client.id)!.expires_at = '2000-01-01T00:00:00Z';
    const headers = { authorization: `Bearer ${client.token}` };
    expect((await f.app.inject({ method: 'GET', url: '/api/connections', headers })).statusCode).toBe(401);
    expect((await f.app.inject({ method: 'GET', url: `/api/tasks/${queued.json().task_id}`, headers })).statusCode).toBe(401);
    expect((await f.app.inject({ method: 'POST', url: '/api/invoke', headers, payload: { connection_id: id, capability_id: capability.id } })).json().error.code).toBe('UNAUTHENTICATED');
  });
  it('pauses queued work and revokes old grants on a personal to organization transition', async () => {
    const f = await fixture(), id = await f.connection(), client = await f.client(id);
    const queued = await f.app.inject({ method: 'POST', url: '/api/tasks', headers: { authorization: `Bearer ${client.token}` }, payload: { connection_id: id, capability_id: capability.id } });
    const paused = await f.app.inject({ method: 'PATCH', url: `/admin/connections/${id}/state`, headers: f.admin.headers, payload: { paused: true } });
    expect(paused.statusCode).toBe(200); expect(f.closeSession).toHaveBeenCalledWith(id);
    expect((await f.db.getTask(queued.json().task_id) as { status: string }).status).toBe('cancelled');
    await f.app.inject({ method: 'PATCH', url: `/admin/connections/${id}/state`, headers: f.admin.headers, payload: { scope: 'organization', confirm_organization: true } });
    expect(f.services.auth.getGrants(client.id)).toEqual([]);
    await f.grant(client.id, id, {});
    await f.app.inject({ method: 'PATCH', url: `/admin/connections/${id}/state`, headers: f.admin.headers, payload: { tags: ['team'] } });
    expect(f.services.auth.getGrants(client.id)).toHaveLength(1);
  });
  it('rejects unknown grant and privacy keys and denies aggregate discovery without a token', async () => {
    const f = await fixture(), id = await f.connection(), client = await f.client(id);
    const invalid = await f.app.inject({ method: 'POST', url: '/admin/grants', headers: f.admin.headers, payload: { client_id: client.id, connection_id: id, capabilities: ['admin'] } });
    expect(invalid.statusCode).toBe(400);
    const denied = await f.app.inject({ method: 'POST', url: '/api/query', payload: { capability_id: capability.id } });
    expect(denied.statusCode).toBe(401);
    const none = await f.app.inject({ method: 'POST', url: '/api/feed', headers: { authorization: `Bearer ${client.token}` }, payload: { input: { limit: 5 } } });
    expect(none.json().results).toEqual([]);
  });
});

describe('honest feed time window', () => {
  it('filters known old items locally and retains unknown times with an explicit warning', () => {
    const now = Date.parse('2026-11-02T12:00:00Z');
    const source = { connection_id: 'feed', connection_label: 'Feed', capability_id: 'feed.list', support: { status: 'supported' as const } };
    const original = ok({ items: [{ id: 'new', published_at: '2026-11-02T11:00:00Z' }, { id: 'old', published_at: '2026-10-30T00:00:00Z' }, { id: 'unknown', published_at: null }] }, source);
    const result = filterFeedSince([original], '6h', now);
    expect((result.results[0]?.data as { items: { id: string }[] }).items.map((item) => item.id)).toEqual(['new', 'unknown']);
    expect(result.filter).toMatchObject({ applied: 'local', unknown_time_items: 1, not_exhaustive: true });
    expect(result.results[0]?.warnings.some((warning) => warning.includes('未知'))).toBe(true);
    expect((original.data as { items: unknown[] }).items).toHaveLength(3);
    expect(() => filterFeedSince([], '99999d', now)).toThrow();
  });
});
