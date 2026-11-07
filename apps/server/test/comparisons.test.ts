import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadManifest } from '@owngate/connector-runtime';
import { ok, type Capability, type ComparisonView, type Connection, type ResultEnvelope } from '@owngate/core';
import { buildServer } from '../src/main.js';
import { ComparisonService } from '../src/comparisons/service.js';
import { adminWithStepUp, loginAdmin, tempDbPath, type AdminSession } from './helpers/admin.js';

const temporary = tempDbPath('owngate-comparison-contract-');
const sourceIds = ['item/一 ?#', 'second'];
const timestamp = '2026-11-04T00:00:00.000Z';
const calls: Array<{ connection: string; capability: string; input: unknown }> = [];
let server: Awaited<ReturnType<typeof buildServer>>;
let admin: AdminSession;
let sourceId: string;
let targetId: string;
let otherSourceId: string;
let rowCount = 2;
let mode = 'normal';
let hold: { capability: string; entered: () => void; wait: Promise<void> } | undefined;
const definition = {
  connector: 'inventory_fixture', version: '1', title: '库存测试', access: 'official_api',
  config: { role: { type: 'string', enum: ['user', 'admin'], default: 'user' }, currency: { type: 'string', enum: ['unknown', 'credits'], default: 'credits' } },
  verification: { capabilities: ['session.check'], auth: 'session.check' },
  views: [{ id: 'stock-comparison', type: 'comparison', title: '库存差额', source: { capability: 'stock.rows', items: 'entries', id: 'key', label: 'title', value: 'metric.remaining', updated_at: 'observed', updated_at_format: 'iso8601', unit: { config: 'currency', allowed: ['credits'] } }, detail: { capability: 'stock.record', input: 'key', id: 'key' }, target: { capability: 'wallet.read', value: 'wallet.available' } }],
  capabilities: [
    { id: 'session.check', kind: 'query', effect: 'read', title: '检查会话', request: { method: 'GET', path: '/identity' }, output: { ready: { from: '$.ready', type: 'boolean' } } },
    { id: 'stock.rows', roles: ['admin'], kind: 'query', effect: 'read', title: '库存记录', input: { type: 'object', additionalProperties: false, properties: { cursor: { type: 'string', default: 'start' }, take: { type: 'integer', minimum: 1, maximum: 200, default: 2 } } }, request: { method: 'GET', path: '/entries' }, output: { entries: { from: '$.entries', schema: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, title: { type: 'string' }, metric: { type: 'object', properties: { remaining: { type: 'number' } } }, observed: { type: 'string' } } } } } } },
    { id: 'stock.record', roles: ['admin'], kind: 'query', effect: 'read', title: '记录详情', input: { type: 'object', required: ['key'], additionalProperties: false, properties: { key: { type: 'string', minLength: 1 } } }, request: { method: 'GET', path: '/entry' }, output: { key: { from: '$.key', type: 'string' } } },
    { id: 'wallet.read', kind: 'query', effect: 'read', title: '当前额度', request: { method: 'GET', path: '/wallet' }, output: { wallet: { from: '$.wallet', schema: { type: 'object', properties: { available: { type: 'number', 'x-unit': 'credits' } } } } } },
    { id: 'stock.write', kind: 'action', effect: 'write', title: '修改库存', request: { method: 'POST', path: '/stock' } },
  ],
};
const compiled = loadManifest(JSON.stringify(definition));
async function dispatch(connection: Connection, capability: Capability, input: unknown): Promise<ResultEnvelope> {
  calls.push({ connection: connection.id, capability: capability.id, input: structuredClone(input) });
  if (hold?.capability === capability.id) { const pending = hold; hold = undefined; pending.entered(); await pending.wait; }
  const source = { connection_id: connection.id, connection_label: connection.label, capability_id: capability.id, support: { status: 'supported' as const } };
  if (capability.id === 'session.check') return ok({ ready: true }, source);
  if (capability.id === 'stock.record') return ok({ key: mode === 'wrong-id' ? 'unrelated' : (input as { key: string }).key }, source);
  if (capability.id === 'stock.rows') return ok({ entries: Array.from({ length: rowCount }, (_, index) => ({ key: sourceIds[index] ?? `entry-${index}`, title: `记录 ${index}`, metric: { remaining: mode === 'overflow' ? Number.MAX_VALUE : 12 }, observed: timestamp })) }, source,
    { fields: mode === 'source-hidden' ? { entries: { status: 'redacted' } } : {} });
  if (capability.id === 'wallet.read') return ok({ wallet: { available: mode === 'overflow' ? -Number.MAX_VALUE : 9 } }, source,
    { fields: { 'wallet.available': { status: mode === 'target-unknown' ? 'unknown' : 'ok', unit: mode === 'mismatch' ? 'other' : 'credits' }, ...(mode === 'target-hidden' ? { wallet: { status: 'redacted' as const } } : {}) } });
  throw new Error('Unexpected synthetic capability');
}
async function start() {
  server = await buildServer({ dbPath: temporary.path, dispatcher: { dispatch } });
  server.connectorRegistry.register(compiled.id, structuredClone(compiled));
  admin = await adminWithStepUp(server.app, admin?.totpSecret);
}
const endpoint = (connection = sourceId, view = 'stock-comparison') => `/admin/connections/${connection}/views/${view}`;
async function create(label: string, role = 'admin') {
  const response = await server.app.inject({ method: 'POST', url: '/admin/connections', headers: admin.headers, payload: { connector_id: compiled.id, label, config: { role, currency: 'credits' } } });
  expect(response.statusCode, response.body).toBe(201); return response.json().id as string;
}
async function link(item: string, connection = sourceId, view = 'stock-comparison') {
  return server.app.inject({ method: 'PUT', url: `${endpoint(connection, view)}/links/${encodeURIComponent(item)}`, headers: admin.headers, payload: { target_connection_id: targetId } });
}
async function run(connection = sourceId, view = 'stock-comparison', input = {}) {
  return server.app.inject({ method: 'POST', url: `${endpoint(connection, view)}/run`, headers: admin.headers, payload: { input } });
}
function barrier(capability: string) {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  hold = { capability, entered, wait }; return { started, release };
}
beforeAll(async () => { await start(); sourceId = await create('仓库 A'); targetId = await create('额度提供方', 'user'); otherSourceId = await create('仓库 B'); });
beforeEach(async () => {
  mode = 'normal'; rowCount = 2; calls.length = 0;
  server.connectorRegistry.register(compiled.id, structuredClone(compiled));
  for (const [id, role] of [[sourceId, 'admin'], [targetId, 'user'], [otherSourceId, 'admin']]) {
    const response = await server.app.inject({ method: 'PATCH', url: `/admin/connections/${id}`, headers: admin.headers, payload: { config: { role, currency: 'credits' } } });
    expect(response.statusCode).toBe(200);
  }
  await server.db.rawRun('DELETE FROM comparison_links');
});
afterAll(async () => { await server?.app.close(); temporary.cleanup(); });

describe('manifest comparison views with arbitrary connector and capability names', () => {
  it('exposes metadata, does no work on GET, verifies details once, applies declared defaults and reuses one target response', async () => {
    const listing = await server.app.inject({ method: 'GET', url: '/admin/connectors', headers: admin.headers });
    expect(listing.json().connectors.find((entry: { id: string }) => entry.id === compiled.id)).toMatchObject({ has_login: false, views: compiled.views });
    expect((await server.app.inject({ method: 'GET', url: `${endpoint()}/links`, headers: admin.headers })).json().links).toEqual([]);
    expect(calls).toHaveLength(0);
    for (const id of sourceIds) expect((await link(id)).statusCode).toBe(200);
    expect(calls.filter(call => call.capability === 'stock.record')).toHaveLength(2);
    const result = await run(); expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ outcome: 'success', rows: [{ item_id: sourceIds[0], source_value: { value: 12, unit: 'credits', updated_at: timestamp }, comparison: { status: 'comparable', difference: 3 } }, { item_id: sourceIds[1], comparison: { difference: 3 } }] });
    expect(calls.filter(call => call.capability === 'stock.rows')).toEqual([{ connection: sourceId, capability: 'stock.rows', input: { cursor: 'start', take: 2 } }]);
    expect(calls.filter(call => call.capability === 'wallet.read')).toHaveLength(1);
    expect(server.services.connections.get(sourceId)?.capability_states['stock.rows']?.status).toBe('supported');
    expect(server.services.connections.get(targetId)?.capability_states['wallet.read']?.status).toBe('supported');
    expect((await run(otherSourceId)).json().rows.every((row: { comparison: { status: string } }) => row.comparison.status === 'unlinked')).toBe(true);
  });

  it('gates mutations and runs with step-up, rejects role violations before reads and keeps GET side effect free', async () => {
    const fresh = await loginAdmin(server.app, admin.totpSecret);
    expect((await server.app.inject({ method: 'GET', url: `${endpoint()}/links` })).statusCode).toBe(401);
    expect((await server.app.inject({ method: 'GET', url: `${endpoint()}/links`, headers: fresh.headers })).statusCode).toBe(200);
    for (const method of ['PUT', 'DELETE', 'POST'] as const) {
      const response = await server.app.inject({ method, url: `${endpoint()}/${method === 'POST' ? 'run' : 'links/second'}`, headers: fresh.headers,
        ...(method === 'PUT' ? { payload: { target_connection_id: targetId } } : method === 'POST' ? { payload: { input: {} } } : {}) });
      expect(response.statusCode).toBe(403); expect(response.json().code).toBe('STEP_UP_REQUIRED');
    }
    expect((await server.app.inject({ method: 'GET', url: `${endpoint(targetId)}/links`, headers: admin.headers })).statusCode).toBe(403);
    expect((await run(targetId)).statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('rejects undeclared views, invalid parameters, self targets and a detail response for another item', async () => {
    expect((await run(sourceId, 'missing')).statusCode).toBe(404);
    expect((await run(sourceId, 'stock-comparison', { take: 201 })).statusCode).toBe(400);
    expect((await run(sourceId, 'stock-comparison', { page: 1 })).statusCode).toBe(400);
    expect((await link(' leading-space')).statusCode).toBe(400);
    expect((await server.app.inject({ method: 'PUT', url: `${endpoint()}/links/second`, headers: admin.headers, payload: { target_connection_id: sourceId } })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    mode = 'wrong-id'; expect((await link('second')).statusCode).toBe(409);
    expect(await server.db.rawQuery('SELECT * FROM comparison_links')).toEqual([]);
  });

  it.each(['target-unknown', 'target-hidden', 'mismatch', 'overflow'])('does not compare when %s', async currentMode => {
    expect((await link(sourceIds[0]!)).statusCode).toBe(200); mode = currentMode;
    const result = await run(); expect(result.statusCode, result.body).toBe(200);
    expect(result.json().rows[0].comparison.status).toBe(currentMode === 'mismatch' ? 'unknown_unit' : 'unavailable');
    expect(result.json().rows[0].comparison.difference).toBeUndefined();
  });

  it('rejects protected target ancestors, hidden source arrays and unconfirmed units without guessing values', async () => {
    const current = server.connectorRegistry.getManifest(compiled.id)!.compiled;
    const wallet = current.capabilities['wallet.read']!;
    (wallet.output['properties'] as Record<string, Record<string, unknown>>)['wallet']!['x-secret'] = true;
    expect((await link('second')).statusCode).toBe(400); expect(calls).toHaveLength(0);
    server.connectorRegistry.register(compiled.id, structuredClone(compiled));
    expect((await link(sourceIds[0]!)).statusCode).toBe(200);
    mode = 'source-hidden'; const hidden = await run(); expect(hidden.json()).toMatchObject({ outcome: 'partial', rows: [] });
    expect(calls.filter(call => call.capability === 'wallet.read')).toHaveLength(0);
    mode = 'normal';
    await server.app.inject({ method: 'PATCH', url: `/admin/connections/${sourceId}`, headers: admin.headers, payload: { config: { role: 'admin', currency: 'unknown' } } });
    const unknown = await run(); expect(unknown.json().rows[0].comparison.status).toBe('unknown_unit');
    expect(unknown.json().rows[0].source_value.unit).toBe('');
  });

  it('keeps a page bounded at 100 rows while retaining a partial result', async () => {
    rowCount = 105; const result = await run(); expect(result.statusCode).toBe(200);
    expect(result.json().rows).toHaveLength(100); expect(result.json().outcome).toBe('partial');
  });

  it.each(['source', 'target'])('rejects late %s configuration changes without producing an old comparable value or retrying', async side => {
    expect((await link(sourceIds[0]!)).statusCode).toBe(200);
    const gate = barrier(side === 'source' ? 'stock.rows' : 'wallet.read');
    const response = run(); await gate.started;
    const id = side === 'source' ? sourceId : targetId;
    await server.app.inject({ method: 'PATCH', url: `/admin/connections/${id}`, headers: admin.headers, payload: { config: { role: side === 'source' ? 'admin' : 'user', currency: 'unknown' } } });
    gate.release(); const result = await response;
    if (side === 'source') expect(result.statusCode).toBe(409);
    else { expect(result.statusCode, result.body).toBe(200); expect(result.json().rows[0]).toMatchObject({ target: null, comparison: { status: 'unavailable' } }); }
    expect(calls.filter(call => call.capability === (side === 'source' ? 'stock.rows' : 'wallet.read'))).toHaveLength(1);
    expect(server.services.connections.get(id)?.capability_states[side === 'source' ? 'stock.rows' : 'wallet.read']?.status).toBe('unverified');
  });

  it('uses the declared authentication check to unblock only role-allowed pending queries without declaring them supported', async () => {
    const connection = server.services.connections.get(sourceId)!;
    const result = await server.app.inject({ method: 'POST', url: `/admin/connections/${sourceId}/verify`, headers: admin.headers });
    expect(result.statusCode).toBe(200); expect(Object.keys(result.json().results)).toEqual(['session.check']);
    expect(calls.map(call => call.capability)).toEqual(['session.check']);
    expect(connection.capability_states['session.check']?.status).toBe('supported');
    expect(connection.capability_states['stock.rows']?.status).toBe('unverified');
    expect(connection.capability_states['stock.write']?.status).toBe('disabled');
    const unavailable = server.connectorRegistry.getManifest(compiled.id)!.compiled;
    unavailable.capabilities['stock.rows']!.roles = ['user'];
    connection.capability_states['stock.rows'] = { status: 'needs_auth' };
    await server.app.inject({ method: 'POST', url: `/admin/connections/${sourceId}/verify`, headers: admin.headers });
    expect(connection.capability_states['stock.rows']?.status).toBe('needs_auth');
  });

  it('migrates legacy IDs once, preserves existing generic links and never resurrects a deleted link on restart', async () => {
    await server.db.rawRun("INSERT INTO channel_upstream_links(connection_id,channel_id,upstream_connection_id,created_at) VALUES(?,?,?,?)", [sourceId, 'legacy-item', targetId, timestamp]);
    await server.db.rawRun("INSERT INTO channel_upstream_links(connection_id,channel_id,upstream_connection_id,created_at) VALUES(?,?,?,?)", [sourceId, 'existing-item', targetId, timestamp]);
    await server.db.rawRun('INSERT INTO comparison_links(connection_id,view_id,item_id,target_connection_id,created_at) VALUES(?,?,?,?,?)', [sourceId, 'channel-upstreams', 'existing-item', otherSourceId, timestamp]);
    await server.db.rawRun("DELETE FROM og_schema_migrations WHERE id='comparison_links_v1'");
    await server.app.close(); await start();
    const legacy = await server.db.rawQuery('SELECT * FROM comparison_links WHERE connection_id=? AND view_id=? ORDER BY item_id', [sourceId, 'channel-upstreams']);
    expect(legacy).toEqual([
      { connection_id: sourceId, view_id: 'channel-upstreams', item_id: 'existing-item', target_connection_id: otherSourceId, created_at: timestamp },
      { connection_id: sourceId, view_id: 'channel-upstreams', item_id: 'legacy-item', target_connection_id: targetId, created_at: timestamp },
    ]);
    await server.db.rawRun('DELETE FROM comparison_links WHERE connection_id=? AND view_id=?', [sourceId, 'channel-upstreams']);
    await server.app.close(); await start();
    expect(await server.db.rawQuery('SELECT * FROM comparison_links')).toEqual([]);
    expect(await server.db.rawQuery('SELECT * FROM channel_upstream_links')).toHaveLength(2);
  });
});

describe('root paths in authorized comparison envelopes', () => {
  it('reads a root source array and root target number, respecting root metadata', async () => {
    const source = { ...structuredClone(compiled.capabilities['stock.rows']!), id: 'root.rows', output: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'number' }, time: { type: 'string' } } } } };
    const detail = { ...structuredClone(compiled.capabilities['stock.record']!), id: 'root.record' };
    const target = { ...structuredClone(compiled.capabilities['wallet.read']!), id: 'root.number', output: { type: 'number' } };
    const view: ComparisonView = { id: 'root-view', type: 'comparison', title: 'Root', source: { capability: source.id, items: '$', id: 'key', value: 'value', updated_at: 'time', updated_at_format: 'iso8601', unit: { config: 'currency', allowed: ['credits'] } }, detail: { capability: detail.id, input: 'key', id: 'key' }, target: { capability: target.id, value: '$' } };
    const connection: Connection = { id: 'root-source', connector_id: 'root', label: 'Root', config: { currency: 'credits' }, capability_states: {}, created_at: timestamp, updated_at: timestamp };
    const targetConnection: Connection = { ...connection, id: 'root-target' };
    let hidden = false;
    const service = new ComparisonService({ db: { rawQuery: async () => [{ connection_id: connection.id, view_id: view.id, item_id: 'item', target_connection_id: 'root-target', created_at: timestamp }], rawRun: async () => ({ changes: 1 }) },
      getConnection: id => id === connection.id ? connection : id === targetConnection.id ? targetConnection : undefined,
      getView: () => view, getCapability: (_id, capabilityId) => [source, detail, target].find(capability => capability.id === capabilityId),
      invoke: async request => ok(request.capability_id === source.id ? [{ key: 'item', value: 10, time: timestamp }] : 7,
        { connection_id: request.connection_id, connection_label: 'Root', capability_id: request.capability_id, support: { status: 'supported' } },
        { fields: request.capability_id === target.id ? { $: { status: hidden ? 'redacted' : 'ok', unit: 'credits' } } : {} }), audit: () => undefined,
    });
    expect((await service.run(connection.id, view.id, {}, 'admin')).rows[0]?.comparison).toMatchObject({ status: 'comparable', difference: 3 });
    hidden = true;
    expect((await service.run(connection.id, view.id, {}, 'admin')).rows[0]?.comparison.status).toBe('unavailable');
  });
});
