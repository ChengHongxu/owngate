import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/main.js';
import { adminWithStepUp, loginAdmin, stepUp, tempDbPath, type AdminSession } from './helpers/admin.js';
import type { ExtensionPreview } from '../src/extensions/service.js';
import type { Capability } from '@owngate/core';

const temp = tempDbPath('owngate-extensions-full-');
let server: Awaited<ReturnType<typeof buildServer>>;
let upstream: Server;
let origin: string;
let admin: AdminSession;
let connectionId: string;
const requests: Array<{ method: string; path: string; query: URLSearchParams; auth: string | undefined }> = [];
const TOKEN = 'fixture-extension-access-token';
const PRIVATE = 'fixture-extension-upstream-secret';
const presentation = { type: 'stats', fields: [
  { path: '$.result.amount', label: '可用额度', format: 'number', prominent: true },
  { path: '$.result.code', label: '返回码', format: 'badge' },
] };

function definition() {
  const response = { '200': { description: 'Fixture', content: { 'application/json': { schema: { type: 'object', properties: {
    amount: { type: 'number', title: '可用额度', description: '当前额度', format: 'double', 'x-unit': 'USD' }, code: { type: 'integer' },
    person: { type: 'string', 'x-sensitivity': 'pii' }, api_key: { type: 'string', 'x-secret': true },
  }, required: ['amount', 'code'] } } } } };
  return {
    openapi: '3.0.3', info: { title: 'Imported fixture', version: '1.0.0' }, servers: [{ url: `${origin}/v1` }],
    security: [{ bearer: [] }], components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    paths: {
      '/accounts/{id}': { get: { operationId: 'account.read', 'x-owngate-presentation': structuredClone(presentation), parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 2 } },
        { name: 'filter', in: 'query', schema: { type: 'string' } },
      ], responses: response } },
      '/other': { get: { operationId: 'other.read', responses: response } },
      '/send': { post: { operationId: 'message.send', responses: response } },
      '/update_balance': { get: { operationId: 'balance.update', responses: response } },
    },
  };
}
async function preview(id: string, source = JSON.stringify(definition())): Promise<ExtensionPreview> {
  const response = await server.app.inject({ method: 'POST', url: '/admin/extensions/preview', headers: admin.headers, payload: { format: 'openapi', source, id } });
  expect(response.statusCode, response.body).toBe(200); return response.json() as ExtensionPreview;
}
async function install(id: string, selected = ['account.read']) {
  const source = JSON.stringify(definition()); const draft = await preview(id, source);
  return server.app.inject({ method: 'POST', url: '/admin/extensions', headers: admin.headers, payload: { format: 'openapi', source, id, enabled_capabilities: selected, preview_fingerprint: draft.fingerprint } });
}
beforeAll(async () => {
  upstream = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    requests.push({ method: request.method ?? '', path: url.pathname, query: url.searchParams, auth: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.statusCode = 401; response.end('{}'); return; }
    response.end(JSON.stringify({ amount: 12.5, code: 0, person: 'Private person', api_key: PRIVATE, unexpected: PRIVATE }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  server = await buildServer({ dbPath: temp.path }); admin = await loginAdmin(server.app);
});
afterAll(async () => { await server?.app.close(); if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve())); temp.cleanup(); });

describe('extension preview, installation and runtime boundaries', () => {
  it('requires admin authentication and step-up for installation, while preview performs no writes or network requests', async () => {
    expect((await server.app.inject({ method: 'GET', url: '/admin/extensions' })).statusCode).toBe(401);
    const draft = await preview('imported_fixture');
    expect(draft.operations).toHaveLength(4); expect(draft.operations.every((operation) => operation.status === 'disabled')).toBe(true);
    expect(draft.operations.find((operation) => operation.id === 'message.send')?.eligible).toBe(false);
    expect(draft.operations.find((operation) => operation.id === 'balance.update')?.eligible).toBe(false);
    expect(await server.db.rawQuery('SELECT id FROM connectors WHERE id=?', ['imported_fixture'])).toEqual([]); expect(requests).toEqual([]);
    const denied = await server.app.inject({ method: 'POST', url: '/admin/extensions', headers: admin.headers, payload: {
      format: 'openapi', source: JSON.stringify(definition()), id: draft.id, enabled_capabilities: ['account.read'], preview_fingerprint: draft.fingerprint,
    } });
    expect(denied.statusCode).toBe(403); expect(denied.json().code).toBe('STEP_UP_REQUIRED');
    admin = await stepUp(server.app, admin);
  });
  it('rejects executable/remote definitions, changed previews, actions and built-in ID overrides', async () => {
    for (const source of ['x-code: console.log(1)', 'a: { $ref: "file:///etc/passwd" }']) {
      const response = await server.app.inject({ method: 'POST', url: '/admin/extensions/preview', headers: admin.headers, payload: { format: 'manifest', source } });
      expect(response.statusCode).toBe(400);
    }
    expect((await install('newapi')).statusCode).toBe(409);
    const action = await install('action_fixture', ['message.send']); expect(action.statusCode).toBe(400); expect(action.json().code).toBe('CAPABILITY_NOT_ELIGIBLE');
    const fakeGet = await install('fake_get_fixture', ['balance.update']); expect(fakeGet.statusCode).toBe(400);
    const draft = await preview('changed_fixture');
    const changed = await server.app.inject({ method: 'POST', url: '/admin/extensions', headers: admin.headers, payload: {
      format: 'openapi', source: JSON.stringify({ ...definition(), info: { title: 'Changed', version: '2.0.0' } }), id: draft.id, enabled_capabilities: ['account.read'], preview_fingerprint: draft.fingerprint,
    } });
    expect(changed.statusCode).toBe(409); expect(changed.json().code).toBe('PREVIEW_CHANGED'); expect(requests).toEqual([]);
  });
  it('rejects invalid presentation before network requests or writes and fingerprints presentation changes', async () => {
    const invalid = definition(); invalid.paths['/accounts/{id}'].get['x-owngate-presentation'].fields[0]!.path = '$.unmapped.amount';
    const rejected = await server.app.inject({ method: 'POST', url: '/admin/extensions/preview', headers: admin.headers, payload: {
      format: 'openapi', source: JSON.stringify(invalid), id: 'invalid_presentation',
    } });
    expect(rejected.statusCode, rejected.body).toBe(400); expect(rejected.body).toContain('presentation');
    const draft = await preview('changed_presentation');
    const changed = definition(); changed.paths['/accounts/{id}'].get['x-owngate-presentation'].fields[0]!.label = 'Updated label';
    const stale = await server.app.inject({ method: 'POST', url: '/admin/extensions', headers: admin.headers, payload: {
      format: 'openapi', source: JSON.stringify(changed), id: draft.id, enabled_capabilities: ['account.read'], preview_fingerprint: draft.fingerprint,
    } });
    expect(stale.statusCode).toBe(409); expect(stale.json().code).toBe('PREVIEW_CHANGED');
    expect(await server.db.rawQuery('SELECT id FROM connectors WHERE id IN (?,?)', ['invalid_presentation', 'changed_presentation'])).toEqual([]);
    expect(requests).toEqual([]);
  });
  it('persists a version-locked definition and allows exactly one concurrent installation for the same ID', async () => {
    const [first, second] = await Promise.all([install('imported_fixture'), install('imported_fixture')]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    const rows = await server.db.rawQuery('SELECT manifest FROM connectors WHERE id=?', ['imported_fixture']) as Array<{ manifest: string }>;
    const stored = JSON.parse(rows[0]!.manifest); expect(stored.kind).toBe('owngate_extension'); expect(stored.enabled_capabilities).toEqual(['account.read']);
    expect(stored.manifest.capabilities.find((capability: { id: string }) => capability.id === 'account.read')?.presentation).toEqual(presentation);
    expect(server.connectorRegistry.getCapability('imported_fixture', 'account.read')?.support.status).toBe('unverified');
    expect(server.connectorRegistry.getCapability('imported_fixture', 'account.read')?.presentation).toEqual(presentation);
    expect(server.connectorRegistry.getCapability('imported_fixture', 'other.read')?.support.status).toBe('disabled');
    const audit = await server.db.rawQuery('SELECT detail FROM audit_log WHERE action=?', ['extension.installed']);
    expect(audit).toHaveLength(1); expect(JSON.stringify(audit)).not.toContain(TOKEN); expect(JSON.stringify(audit)).not.toContain('/accounts');
  });
  it('creates a connection without erasing its definition, verifies selected reads and blocks all unselected or write operations', async () => {
    const created = await server.app.inject({ method: 'POST', url: '/admin/connections', headers: admin.headers, payload: { connector_id: 'imported_fixture', label: 'Imported account', config: { base_url: origin } } });
    expect(created.statusCode, created.body).toBe(201); connectionId = created.json().id as string;
    const credentials = await server.app.inject({ method: 'PUT', url: `/admin/connections/${connectionId}/credentials`, headers: admin.headers, payload: { credentials: { access_token: TOKEN } } });
    expect(credentials.statusCode).toBe(200); expect(requests).toEqual([]);
    const verified = await server.app.inject({ method: 'POST', url: `/admin/connections/${connectionId}/verify`, headers: admin.headers, payload: { capability_id: 'account.read', input: { path_id: 'x/y?scope=all' } } });
    expect(verified.statusCode, verified.body).toBe(200); expect(verified.json().results['account.read'].outcome).toBe('success');
    expect(verified.body).not.toContain(PRIVATE); expect(verified.json().results['account.read'].data.result).toMatchObject({ amount: 12.5, code: 0 });
    expect(requests.at(-1)?.path).toBe('/v1/accounts/x%2Fy%3Fscope%3Dall'); expect(requests.at(-1)?.query.get('page')).toBe('2'); expect(requests.at(-1)?.query.has('filter')).toBe(false);
    const count = requests.length;
    for (const id of ['other.read', 'message.send', 'balance.update']) {
      const result = await server.app.inject({ method: 'POST', url: '/admin/invoke', headers: admin.headers, payload: { connection_id: connectionId, capability_id: id, input: {} } });
      expect(result.json().error.code).toBe('CAPABILITY_DISABLED');
      const checked = await server.app.inject({ method: 'POST', url: `/admin/connections/${connectionId}/verify`, headers: admin.headers, payload: { capability_id: id, input: {} } });
      expect(checked.statusCode).toBe(id === 'other.read' ? 200 : 400);
      expect(checked.json().results?.[id]).toBeUndefined();
    }
    expect(requests).toHaveLength(count);
    const rows = await server.db.rawQuery('SELECT manifest FROM connectors WHERE id=?', ['imported_fixture']) as Array<{ manifest: string }>;
    expect(JSON.parse(rows[0]!.manifest).kind).toBe('owngate_extension');
    const catalog = await server.app.inject({ method: 'GET', url: `/admin/capabilities?connection_id=${connectionId}`, headers: admin.headers });
    expect(catalog.statusCode).toBe(200);
    const capability = (catalog.json().capabilities as Capability[]).find(value => value.id === 'account.read');
    expect(capability?.presentation).toEqual(presentation);
    expect(capability?.output).toMatchObject({ properties: { result: { properties: { amount: {
      title: '可用额度', description: '当前额度', format: 'double', 'x-unit': 'USD',
    } } } } });
  });
  it('applies imported nested privacy metadata and grant scope to actual token calls', async () => {
    const created = await server.app.inject({ method: 'POST', url: '/admin/clients', headers: admin.headers, payload: { label: 'Imported API client' } });
    const client = created.json() as { id: string; token: string };
    const granted = await server.app.inject({ method: 'POST', url: '/admin/grants', headers: admin.headers, payload: { client_id: client.id, connection_id: connectionId, capabilities: ['account.read'] } });
    expect(granted.statusCode).toBe(201);
    const response = await server.app.inject({ method: 'POST', url: '/api/invoke', headers: { authorization: `Bearer ${client.token}` }, payload: { connection_id: connectionId, capability_id: 'account.read', input: { path_id: 'account' }, no_cache: true } });
    expect(response.json().outcome).toBe('success'); expect(response.json().data.result).toMatchObject({ amount: 12.5, person: null, api_key: '[REDACTED]' });
    expect(response.json()).not.toHaveProperty('presentation'); expect(response.body).not.toContain('可用额度');
    expect(response.body).not.toContain('Private person'); expect(response.body).not.toContain(PRIVATE); expect(response.body).not.toContain(TOKEN);
    const before = requests.length;
    const denied = await server.app.inject({ method: 'POST', url: '/api/invoke', headers: { authorization: `Bearer ${client.token}` }, payload: { connection_id: connectionId, capability_id: 'other.read', input: {} } });
    expect(denied.json().error.code).toBe('PERMISSION_DENIED'); expect(requests).toHaveLength(before);
  });
  it('restores an installed extension and its encrypted credentials after a real server restart', async () => {
    const rows = await server.db.rawQuery('SELECT manifest FROM connectors WHERE id=?', ['imported_fixture']) as Array<{ manifest: string }>;
    expect(JSON.parse(rows[0]!.manifest).kind).toBe('owngate_extension');
    const credentials = await server.db.rawQuery('SELECT ciphertext FROM credentials WHERE connection_id=?', [connectionId]) as Array<{ ciphertext: string }>;
    expect(credentials).not.toHaveLength(0);
    expect(JSON.stringify(credentials)).not.toContain(TOKEN);
    await server.app.close(); server = await buildServer({ dbPath: temp.path }); admin = await adminWithStepUp(server.app, admin.totpSecret);
    const list = await server.app.inject({ method: 'GET', url: '/admin/extensions', headers: admin.headers });
    expect(list.json().extensions).toHaveLength(1); expect(list.json().extensions[0].status).toBe('installed');
    const catalog = await server.app.inject({ method: 'GET', url: `/admin/capabilities?connection_id=${connectionId}`, headers: admin.headers });
    expect((catalog.json().capabilities as Capability[]).find(value => value.id === 'account.read')?.presentation).toEqual(presentation);
    const response = await server.app.inject({ method: 'POST', url: '/admin/invoke', headers: admin.headers, payload: { connection_id: connectionId, capability_id: 'account.read', input: { path_id: 'account', query_filter: 'x&scope=all' }, no_cache: true } });
    expect(response.json().outcome, response.body).toBe('success'); expect(response.body).not.toContain(PRIVATE);
    expect(requests.at(-1)?.query.get('filter')).toBe('x&scope=all'); expect(requests.at(-1)?.query.has('scope')).toBe(false);
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
    const preserved = await server.db.rawQuery('SELECT manifest FROM connectors WHERE id=?', ['imported_fixture']) as Array<{ manifest: string }>;
    expect(JSON.parse(preserved[0]!.manifest).kind).toBe('owngate_extension');
  });
  it('refuses startup before restoring old connections when a later built-in reuses an installed extension ID', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'owngate-future-builtin-'));
    mkdirSync(join(directory, 'imported_fixture'));
    writeFileSync(join(directory, 'imported_fixture', 'manifest.yaml'), JSON.stringify({
      connector: 'imported_fixture', title: 'Future unrelated built-in', version: '99.0.0', access: 'official_api', http: { base: 'https://unrelated.invalid' },
      capabilities: [{ id: 'account.read', title: 'Read', kind: 'query', effect: 'read', request: { method: 'GET', path: '/unrelated' }, output: { amount: { from: '$.amount', type: 'number' } } }],
    }));
    await server.app.close(); const count = requests.length;
    try { await expect(buildServer({ dbPath: temp.path, connectorsDir: directory })).rejects.toThrow(/内置连接器 ID 冲突/); }
    finally { rmSync(directory, { recursive: true, force: true }); }
    expect(requests).toHaveLength(count);
    server = await buildServer({ dbPath: temp.path }); admin = await adminWithStepUp(server.app, admin.totpSecret);
    expect(server.connectorRegistry.getManifest('imported_fixture')?.compiled.version).toBe('1.0.0');
  });
});
