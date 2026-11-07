import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ComparisonView, JSONSchema, VerificationPlan } from '@owngate/core';
import { buildServer } from '../src/main.js';
import type { ExtensionPreview } from '../src/extensions/service.js';
import type { ComparisonResult } from '../src/comparisons/service.js';
import { adminWithStepUp, tempDbPath, type AdminSession } from './helpers/admin.js';

const temp = tempDbPath('owngate-extension-views-');
const connectorsDir = join(dirname(temp.path), 'empty-connectors');
const FULL_ID = 'warehouse_fixture';
const SOURCE_ONLY_ID = 'warehouse_source_only';
const SOURCE = 'stock.snapshot';
const DETAIL = 'stock.entry';
const VIEW_ID = 'stock-audit';
const CHECKED_AT = '2026-11-02T08:00:00.000Z';
const verification: VerificationPlan = { capabilities: [SOURCE], auth: SOURCE };
const requests: Array<{ method: string; path: string }> = [];
let server: Awaited<ReturnType<typeof buildServer>>;
let upstream: Server;
let origin: string;
let admin: AdminSession;
let fingerprint: string;
let connectionId: string;

const object = (properties: Record<string, JSONSchema>): JSONSchema => ({ type: 'object', properties, additionalProperties: false });

function view(): ComparisonView {
  return {
    id: VIEW_ID, type: 'comparison', title: '库存与供应量', description: '为每条库存记录单独选择供应连接。',
    source: { capability: SOURCE, items: '$.result.warehouse.entries', id: 'record.sku', label: 'title', value: 'measure.quantity',
      updated_at: 'measure.checked', updated_at_format: 'iso8601', unit: { config: 'count_unit', allowed: ['pieces'] } },
    detail: { capability: DETAIL, input: 'path_reference', id: '$.result.record.sku' },
    // Deliberately belongs to another connector, rather than a local operation.
    target: { capability: 'supplier.capacity', value: '$.availability.total' },
  };
}

function normalizedView(): ComparisonView {
  const value = view();
  value.source.items = 'result.warehouse.entries';
  value.detail.id = 'result.record.sku';
  value.target.value = 'availability.total';
  return value;
}

function definition() {
  const response = (schema: JSONSchema) => ({ '200': { description: 'Controlled local fixture', content: { 'application/json': { schema } } } });
  return {
    openapi: '3.0.3', info: { title: 'Warehouse fixture', version: '1.0.0' }, servers: [{ url: `${origin}/warehouse-api` }],
    'x-owngate-config': { count_unit: { type: 'string', enum: ['unknown', 'pieces'], default: 'unknown', label: '数量单位' } },
    'x-owngate-views': [view()], 'x-owngate-verification': structuredClone(verification),
    paths: {
      '/stock': { get: { operationId: SOURCE, summary: '库存快照', responses: response(object({ warehouse: object({ entries: {
        type: 'array', items: object({ record: object({ sku: { type: 'string' } }), title: { type: 'string' },
          measure: object({ quantity: { type: 'number', 'x-unit': 'pieces' }, checked: { type: 'string', format: 'date-time' } }) }),
      } }) })) } },
      '/stock/{reference}': { get: { operationId: DETAIL, summary: '库存条目', parameters: [
        { in: 'path', name: 'reference', required: true, schema: { type: 'string' } },
      ], responses: response(object({ record: object({ sku: { type: 'string' } }) })) } },
    },
  };
}

async function preview(id: string, source = JSON.stringify(definition())): Promise<ExtensionPreview> {
  const result = await server.app.inject({ method: 'POST', url: '/admin/extensions/preview', headers: admin.headers,
    payload: { format: 'openapi', source, id } });
  expect(result.statusCode, result.body).toBe(200);
  return result.json() as ExtensionPreview;
}

async function install(id: string, enabled: string[]) {
  const source = JSON.stringify(definition());
  const draft = await preview(id, source);
  const result = await server.app.inject({ method: 'POST', url: '/admin/extensions', headers: admin.headers,
    payload: { format: 'openapi', source, id, enabled_capabilities: enabled, preview_fingerprint: draft.fingerprint } });
  expect(result.statusCode, result.body).toBe(201);
  expect(result.json().fingerprint).toBe(draft.fingerprint);
  return draft;
}

async function createConnection(connectorId: string) {
  const result = await server.app.inject({ method: 'POST', url: '/admin/connections', headers: admin.headers,
    payload: { connector_id: connectorId, label: '受控库存站点', config: { base_url: origin, count_unit: 'pieces' } } });
  expect(result.statusCode, result.body).toBe(201);
  return result.json().id as string;
}

async function catalogView(connectorId: string) {
  const result = await server.app.inject({ method: 'GET', url: '/admin/connectors', headers: admin.headers });
  expect(result.statusCode, result.body).toBe(200);
  const connector = (result.json().connectors as Array<{ id: string; views?: ComparisonView[] }>).find(value => value.id === connectorId);
  expect(connector).toBeDefined();
  expect(connector!.views).toEqual([normalizedView()]);
}

beforeAll(async () => {
  mkdirSync(connectorsDir);
  upstream = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    requests.push({ method: request.method ?? '', path: url.pathname });
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/warehouse-api/stock') {
      response.end(JSON.stringify({ warehouse: { entries: [{ record: { sku: 'sku-17' }, title: '紧固件',
        measure: { quantity: 18, checked: CHECKED_AT } }] } }));
    } else if (url.pathname === '/warehouse-api/stock/sku-17') response.end(JSON.stringify({ record: { sku: 'sku-17' } }));
    else { response.statusCode = 404; response.end(JSON.stringify({ error: 'Unrecognized fixture route' })); }
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  server = await buildServer({ dbPath: temp.path, connectorsDir });
  admin = await adminWithStepUp(server.app);
});

afterAll(async () => {
  await server?.app.close();
  if (upstream) await new Promise<void>(resolve => upstream.close(() => resolve()));
  temp.cleanup();
});

describe('imported connector view lifecycle through real server routes', () => {
  it('previews complete normalized view and verification declarations without installing, authorizing or calling the site', async () => {
    const draft = await preview(FULL_ID);
    expect(draft.views).toEqual([normalizedView()]);
    expect(draft.verification).toEqual(verification);
    expect(draft.config['count_unit']).toMatchObject({ type: 'string', enum: ['unknown', 'pieces'] });
    expect(draft.operations.map(operation => [operation.id, operation.eligible, operation.status])).toEqual([
      [SOURCE, true, 'disabled'], [DETAIL, true, 'disabled'],
    ]);
    expect(await server.db.rawQuery('SELECT id FROM connectors')).toEqual([]);
    expect(await server.db.rawQuery('SELECT * FROM grants')).toEqual([]);
    expect(requests).toEqual([]);
  });

  it.each(['view', 'verification'] as const)('rejects a stale preview when only the %s declaration changes', async field => {
    const id = `changed_${field}`;
    const draft = await preview(id);
    const changed = definition();
    if (field === 'view') changed['x-owngate-views'][0]!.title = '另一种库存比较';
    else changed['x-owngate-verification'] = { capabilities: [] };
    const result = await server.app.inject({ method: 'POST', url: '/admin/extensions', headers: admin.headers,
      payload: { format: 'openapi', source: JSON.stringify(changed), id, enabled_capabilities: [SOURCE, DETAIL], preview_fingerprint: draft.fingerprint } });
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json().code).toBe('PREVIEW_CHANGED');
    expect(await server.db.rawQuery('SELECT id FROM connectors WHERE id=?', [id])).toEqual([]);
    expect(await server.db.rawQuery('SELECT * FROM grants')).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('installs selected source and detail queries and exposes the complete generic view without granting clients or querying the site', async () => {
    const draft = await install(FULL_ID, [SOURCE, DETAIL]);
    fingerprint = draft.fingerprint;
    await catalogView(FULL_ID);
    const stored = await server.db.rawQuery('SELECT manifest FROM connectors WHERE id=?', [FULL_ID]) as Array<{ manifest: string }>;
    expect(JSON.parse(stored[0]!.manifest)).toMatchObject({ kind: 'owngate_extension', fingerprint,
      enabled_capabilities: [SOURCE, DETAIL], manifest: { views: [normalizedView()], verification } });
    expect(server.connectorRegistry.getManifest(FULL_ID)?.compiled.verification).toEqual(verification);
    connectionId = await createConnection(FULL_ID);
    const links = await server.app.inject({ method: 'GET', url: `/admin/connections/${connectionId}/views/${VIEW_ID}/links`, headers: admin.headers });
    expect(links.statusCode, links.body).toBe(200);
    expect(links.json()).toEqual({ links: [] });
    expect(await server.db.rawQuery('SELECT * FROM grants')).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('runs the declared non-New-API source only on request and still denies an ungranted client token', async () => {
    const issued = await server.app.inject({ method: 'POST', url: '/admin/clients', headers: admin.headers,
      payload: { label: '未授权的库存客户端' } });
    expect(issued.statusCode, issued.body).toBe(201);
    const client = issued.json() as { id: string; token: string };
    const result = await server.app.inject({ method: 'POST', url: `/admin/connections/${connectionId}/views/${VIEW_ID}/run`, headers: admin.headers, payload: { input: {} } });
    expect(result.statusCode, result.body).toBe(200);
    const comparison = result.json() as ComparisonResult;
    expect(comparison.outcome).toBe('partial');
    expect(comparison.source.outcome).toBe('success');
    expect(comparison.source.source.capability_id).toBe(SOURCE);
    expect(comparison.rows).toMatchObject([{ item_id: 'sku-17', label: '紧固件',
      source_value: { value: 18, unit: 'pieces', updated_at: CHECKED_AT }, target_connection_id: null, target: null,
      comparison: { status: 'unlinked' } }]);
    expect(requests).toEqual([{ method: 'GET', path: '/warehouse-api/stock' }]);
    expect(server.services.connections.get(connectionId)?.capability_states[SOURCE]?.status).toBe('supported');
    const denied = await server.app.inject({ method: 'POST', url: '/api/invoke', headers: { authorization: `Bearer ${client.token}` },
      payload: { connection_id: connectionId, capability_id: SOURCE, input: {}, no_cache: true } });
    expect(denied.json().error?.code, denied.body).toBe('PERMISSION_DENIED');
    expect(await server.db.rawQuery('SELECT * FROM grants WHERE client_id=?', [client.id])).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('retains view declarations but rejects execution before HTTP when the detail capability was not enabled', async () => {
    const before = requests.length;
    await install(SOURCE_ONLY_ID, [SOURCE]);
    await catalogView(SOURCE_ONLY_ID);
    const id = await createConnection(SOURCE_ONLY_ID);
    expect(server.services.connections.get(id)?.capability_states[DETAIL]?.status).toBe('disabled');
    const result = await server.app.inject({ method: 'POST', url: `/admin/connections/${id}/views/${VIEW_ID}/run`, headers: admin.headers, payload: { input: {} } });
    expect(result.statusCode, result.body).toBe(403);
    expect(result.json().code).toBe('PERMISSION_DENIED');
    expect(requests).toHaveLength(before);
  });

  it('restores view, verification, capability selection and the same fingerprint after an actual server restart', async () => {
    const before = requests.length;
    await server.app.close();
    server = await buildServer({ dbPath: temp.path, connectorsDir });
    admin = await adminWithStepUp(server.app, admin.totpSecret);
    await catalogView(FULL_ID);
    await catalogView(SOURCE_ONLY_ID);
    const installed = await server.app.inject({ method: 'GET', url: '/admin/extensions', headers: admin.headers });
    const restored = (installed.json().extensions as Array<{ id: string; fingerprint: string; status: string; enabled_capabilities: string[] }>).find(extension => extension.id === FULL_ID);
    expect(restored).toMatchObject({ fingerprint, status: 'installed', enabled_capabilities: [SOURCE, DETAIL] });
    expect((await preview(FULL_ID)).fingerprint).toBe(fingerprint);
    expect(server.connectorRegistry.getManifest(FULL_ID)?.compiled.verification).toEqual(verification);
    expect(server.connectorRegistry.getCapability(FULL_ID, DETAIL)?.support.status).toBe('unverified');
    expect(server.connectorRegistry.getCapability(SOURCE_ONLY_ID, DETAIL)?.support.status).toBe('disabled');
    const links = await server.app.inject({ method: 'GET', url: `/admin/connections/${connectionId}/views/${VIEW_ID}/links`, headers: admin.headers });
    expect(links.statusCode, links.body).toBe(200);
    expect(links.json()).toEqual({ links: [] });
    expect(await server.db.rawQuery('SELECT * FROM grants')).toEqual([]);
    expect(requests).toHaveLength(before);
  });
});
