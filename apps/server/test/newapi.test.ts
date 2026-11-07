import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { buildServer } from '../src/main.js';
import { adminWithStepUp, tempDbPath, type AdminSession } from './helpers/admin.js';
import type { ResultEnvelope } from '@owngate/core';
import type { ComparisonResult } from '../src/comparisons/service.js';

const temp = tempDbPath('owngate-newapi-full-');
let server: Awaited<ReturnType<typeof buildServer>>;
let upstream: Server;
let origin: string;
let admin: AdminSession;
let userId: string;
let adminId: string;
let failingId: string;
const requests: Array<{ path: string; method: string; user: string; query: URLSearchParams }> = [];
const TIME = 1793664000;
const PAT = 'fixture-newapi-management-pat';
const SITE_KEY = 'fixture-must-never-expose-channel-key';

async function connection(role: 'user' | 'admin', user: string, unit = 'unknown') {
  const created = await server.app.inject({ method: 'POST', url: '/admin/connections', headers: admin.headers,
    payload: { connector_id: 'newapi', label: `Fixture ${user}`, config: { base_url: origin, user_id: user, role, channel_balance_unit: unit, quota_per_unit: 1000 } } });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  const credentials = await server.app.inject({ method: 'PUT', url: `/admin/connections/${id}/credentials`, headers: admin.headers, payload: { credentials: { access_token: PAT } } });
  expect(credentials.statusCode).toBe(200); expect(credentials.json().verified).toBe(user !== 'failing');
  return id;
}
async function verify(id: string, capabilityId: string, input: unknown = {}) {
  const response = await server.app.inject({ method: 'POST', url: `/admin/connections/${id}/verify`, headers: admin.headers, payload: { capability_id: capabilityId, input } });
  expect(response.statusCode).toBe(200);
  return response.json().results[capabilityId] as ResultEnvelope | undefined;
}
async function reconcile() {
  const response = await server.app.inject({ method: 'POST', url: `/admin/connections/${adminId}/views/channel-upstreams/run`, headers: admin.headers, payload: { input: { page: 1, page_size: 20 } } });
  expect(response.statusCode).toBe(200); return response.json() as ComparisonResult;
}
beforeAll(async () => {
  upstream = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    const user = String(request.headers['new-api-user'] ?? '');
    requests.push({ path: url.pathname, method: request.method ?? '', user, query: url.searchParams });
    response.setHeader('content-type', 'application/json');
    const send = (data: unknown) => response.end(JSON.stringify({ success: true, data }));
    if (request.headers.authorization !== `Bearer ${PAT}` || user === 'failing') { response.statusCode = 401; return response.end(JSON.stringify({ success: false })); }
    if (url.pathname === '/api/user/self') return send({ quota: 7000, used_quota: 3000, request_count: 42, username: `User ${user}`, email: 'private@example.invalid', access_token: SITE_KEY, password: SITE_KEY });
    if (url.pathname === '/api/user/models') return send(['gpt-fixture']);
    if (url.pathname === '/api/pricing') return send([{ model_name: 'gpt-fixture', model_price: 0.02, model_ratio: 1, completion_ratio: 2, quota_type: 0, enable_groups: ['default'], private_config: SITE_KEY }]);
    if (url.pathname === '/api/status/test') return response.end(JSON.stringify({ success: true, http_stats: { harmless: true }, debug: SITE_KEY }));
    if (url.pathname === '/api/channel/') return send({ total: 3, items: [1, 2, 3].map((id) => ({ id, name: `Channel ${id}`, type: 1, status: 1, balance: 10, balance_updated_time: TIME, used_quota: 5, models: 'gpt-fixture', key: SITE_KEY, settings: SITE_KEY, header_override: `Bearer ${SITE_KEY}` })) });
    if (/^\/api\/channel\/\d+$/.test(url.pathname)) return send({ id: Number(url.pathname.split('/').at(-1)), name: 'Channel detail', balance: 10, balance_updated_time: TIME, key: SITE_KEY });
    if (['/api/log/self/stat', '/api/log/stat'].includes(url.pathname)) return send({ quota: 4000, rpm: 3, tpm: 800 });
    if (['/api/log/self', '/api/log/'].includes(url.pathname)) return send({ total: 1, items: [{ id: 7, created_at: TIME, model_name: 'gpt-fixture', quota: 123, prompt_tokens: 30, completion_tokens: 20, use_time: 1, channel: 1, user_id: 42, username: 'Private Person', content: SITE_KEY, other: SITE_KEY, ip: '192.168.1.1', token_name: SITE_KEY }] });
    if (url.pathname === '/api/user/') return send({ total: 1, items: [{ id: 42, username: 'Private Person', display_name: 'Private Display', role: 1, status: 1, quota: 7000, used_quota: 3000, request_count: 42, password: SITE_KEY, access_token: SITE_KEY, settings: SITE_KEY }] });
    response.statusCode = 404; response.end(JSON.stringify({ success: false, message: 'unrecognized fixture route' }));
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  server = await buildServer({ dbPath: temp.path }); admin = await adminWithStepUp(server.app);
  userId = await connection('user', 'user'); adminId = await connection('admin', 'admin'); failingId = await connection('user', 'failing');
});
afterAll(async () => { await server?.app.close(); if (upstream) await new Promise<void>((done) => upstream.close(() => done())); temp.cleanup(); });

describe('New API public endpoint contracts and role boundary', () => {
  it('filters admin capabilities from ordinary connections and blocks both admin and token invocation before HTTP', async () => {
    const caps = await server.app.inject({ method: 'GET', url: `/admin/capabilities?connector_id=newapi&connection_id=${userId}`, headers: admin.headers });
    const names = caps.json().capabilities.map((cap: { id: string }) => cap.id) as string[];
    expect(names).toContain('model.prices'); expect(names).not.toContain('channel.list'); expect(names).not.toContain('admin.users');
    const before = requests.length;
    const denied = await server.app.inject({ method: 'POST', url: '/admin/invoke', headers: admin.headers, payload: { connection_id: userId, capability_id: 'channel.list', input: {} } });
    expect(denied.json().outcome).toBe('error'); expect(requests).toHaveLength(before);
    const issued = await server.app.inject({ method: 'POST', url: '/admin/clients', headers: admin.headers, payload: { label: 'Role boundary client' } });
    await server.app.inject({ method: 'POST', url: '/admin/grants', headers: admin.headers, payload: { client_id: issued.json().id, connection_id: userId, capabilities: ['*'] } });
    const tokenDenied = await server.app.inject({ method: 'POST', url: '/api/invoke', headers: { authorization: `Bearer ${issued.json().token}` }, payload: { connection_id: userId, capability_id: 'channel.list', input: {} } });
    expect(tokenDenied.json().outcome).toBe('error'); expect(requests).toHaveLength(before);
    expect((await server.app.inject({ method: 'GET', url: `/admin/connections/${userId}/views/channel-upstreams/links`, headers: admin.headers })).statusCode).toBe(403);
  });
  it('executes every declared read endpoint against official response fixtures, applying defaults and safe projection', async () => {
    const inputs: Record<string, Record<string, unknown>> = {
      'usage.logs': { start_timestamp: TIME - 3600, end_timestamp: TIME }, 'usage.summary': { start_timestamp: TIME - 3600, end_timestamp: TIME },
      'channel.balance': { channel_id: 1 }, 'admin.logs': { start_timestamp: TIME - 3600, end_timestamp: TIME, channel_id: 1, model_name: 'gpt/a&scope=all' },
      'admin.usage': { start_timestamp: TIME - 3600, end_timestamp: TIME },
    };
    const manifest = server.connectorRegistry.getManifest('newapi')!;
    for (const cap of Object.values(manifest.compiled.capabilities)) {
      const result = await verify(adminId, cap.id, inputs[cap.id] ?? {});
      expect(result, cap.id).toBeDefined(); expect(result!.outcome, cap.id).toBe('success');
      expect(JSON.stringify(result), cap.id).not.toContain(SITE_KEY); expect(JSON.stringify(result), cap.id).not.toContain('192.168.1.1');
    }
    const log = requests.find((request) => request.path === '/api/log/' && request.query.get('model_name') === 'gpt/a&scope=all');
    expect(log?.query.get('channel')).toBe('1'); expect(log?.query.get('page_size')).toBe('20'); expect(log?.query.get('p')).toBe('1');
    expect(log?.query.has('scope')).toBe(false);
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
    expect(requests.some((request) => request.path.includes('update_balance') || request.path.endsWith('/key'))).toBe(false);
  });
  it('uses personal PII policy after projecting nested admin data and never returns keys to token clients', async () => {
    const issued = await server.app.inject({ method: 'POST', url: '/admin/clients', headers: admin.headers, payload: { label: 'Nested privacy client' } });
    await server.app.inject({ method: 'POST', url: '/admin/grants', headers: admin.headers, payload: { client_id: issued.json().id, connection_id: adminId, capabilities: ['admin.users', 'channel.list'] } });
    const result = await server.app.inject({ method: 'POST', url: '/api/invoke', headers: { authorization: `Bearer ${issued.json().token}` }, payload: { connection_id: adminId, capability_id: 'admin.users', input: {}, no_cache: true } });
    expect(result.json().outcome).toBe('success'); expect(result.body).not.toContain('Private Person'); expect(result.body).not.toContain(SITE_KEY);
    expect(result.json().data.users[0].quota).toBe(7000); expect(result.json().data.users[0].username).toBeNull();
  });
});

describe('explicit channel mappings and partial reconciliation', () => {
  it('does not guess upstreams and saves only a verified channel and explicitly selected existing balance connection', async () => {
    const initial = await reconcile(); expect(initial.outcome).toBe('partial'); expect(initial.rows.every((row) => row.comparison.status === 'unlinked')).toBe(true);
    const beforeInvalidIds = requests.length;
    for (const itemId of ['01', '+1', '1.0', 'NaN', '9007199254740992']) {
      const rejected = await server.app.inject({ method: 'PUT', url: `/admin/connections/${adminId}/views/channel-upstreams/links/${encodeURIComponent(itemId)}`, headers: admin.headers, payload: { target_connection_id: userId } });
      expect(rejected.statusCode, itemId).toBe(400);
    }
    expect(requests).toHaveLength(beforeInvalidIds);
    for (const [channelId, upstreamId] of [['1', userId], ['2', failingId]]) {
      const saved = await server.app.inject({ method: 'PUT', url: `/admin/connections/${adminId}/views/channel-upstreams/links/${channelId}`, headers: admin.headers, payload: { target_connection_id: upstreamId } });
      expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().target_connection_id).toBe(upstreamId);
    }
    const invalid = await server.app.inject({ method: 'PUT', url: `/admin/connections/${adminId}/views/channel-upstreams/links/1`, headers: admin.headers, payload: { target_connection_id: adminId } });
    expect(invalid.statusCode).toBe(400);
    const links = await server.db.rawQuery('SELECT * FROM comparison_links'); expect(links).toHaveLength(2);
    expect(JSON.stringify(links)).not.toContain(PAT); expect(JSON.stringify(links)).not.toContain(SITE_KEY);
  });
  it('preserves successful, failed and unlinked rows without comparing an unknown site currency', async () => {
    const result = await reconcile();
    expect(result.outcome).toBe('partial'); expect(result.rows).toHaveLength(3);
    expect(result.rows[0]!.comparison.status).toBe('unknown_unit'); expect(result.rows[0]!.target?.outcome).toBe('success');
    expect(result.rows[1]!.comparison.status).toBe('unavailable'); expect(result.rows[1]!.target?.outcome).toBe('error');
    expect(result.rows[2]!.comparison.status).toBe('unlinked'); expect(result.rows.every((row) => row.comparison.difference === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SITE_KEY);
  });
  it('compares only explicitly confirmed USD against USD and keeps raw quota incomparable', async () => {
    const c = server.services.connections.get(adminId)!;
    const response = await server.app.inject({ method: 'PATCH', url: `/admin/connections/${adminId}`, headers: admin.headers, payload: { config: { ...c.config, channel_balance_unit: 'USD' } } });
    expect(response.statusCode).toBe(200); await verify(adminId, 'channel.list', {});
    const result = await reconcile(); expect(result.rows[0]!.comparison).toMatchObject({ status: 'comparable', unit: 'USD', difference: 3 });
    const user = server.services.connections.get(userId)!;
    await server.app.inject({ method: 'PATCH', url: `/admin/connections/${userId}`, headers: admin.headers, payload: { config: { ...user.config, quota_per_unit: 2000 } } });
    await verify(userId, 'account.balance', {});
    const changed = await reconcile(); expect(changed.rows[0]!.comparison.difference).toBe(6.5);
    const { quota_per_unit: _ratio, ...unknownRatio } = server.services.connections.get(userId)!.config;
    await server.app.inject({ method: 'PATCH', url: `/admin/connections/${userId}`, headers: admin.headers, payload: { config: unknownRatio } });
    await verify(userId, 'account.balance', {});
    const raw = await reconcile();
    expect(raw.rows[0]!.target?.fields['quota']?.unit).toBe('quota');
    expect(raw.rows[0]!.comparison.status).toBe('unknown_unit'); expect(raw.rows[0]!.comparison.difference).toBeUndefined();
  });
  it('restores persisted explicit links after an actual server restart and deletes links without touching upstream credentials', async () => {
    await server.app.close(); server = await buildServer({ dbPath: temp.path }); admin = await adminWithStepUp(server.app, admin.totpSecret);
    const links = await server.app.inject({ method: 'GET', url: `/admin/connections/${adminId}/views/channel-upstreams/links`, headers: admin.headers }); expect(links.json().links).toHaveLength(2);
    const deleted = await server.app.inject({ method: 'DELETE', url: `/admin/connections/${adminId}/views/channel-upstreams/links/1`, headers: admin.headers }); expect(deleted.statusCode).toBe(200);
    expect(await server.db.listCredentials(userId)).toHaveLength(1);
    expect((await reconcile()).rows[0]!.comparison.status).toBe('unlinked');
  });
});
