// Client-token listing (GET /api/connections, GET /api/connections/:id/capabilities),
// its agreement with MCP list_connections, and state restore across a restart
// (clients, grants and connections reloaded from the DB by buildServer()).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ok, type ResultEnvelope, type Dispatcher } from '@owngate/core';
import { buildServer } from '../src/main.js';
import { adminWithStepUp, tempDbPath } from './helpers/admin.js';
import type { AdminSession } from './helpers/admin.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

const CONNECTOR = 'list-connector';

function cap(id: string, kind: 'query' | 'action' = 'query') {
  return {
    id,
    kind,
    title: id,
    description: id,
    effect: kind === 'query' ? 'read' : 'write',
    approval: kind === 'query' ? 'never' : 'always',
    input: { type: 'object' },
    output: { type: 'object', properties: { message: { type: 'string', 'x-sensitivity': 'content' } } },
    cache: null,
    long_running: false,
    cancel: 'none',
    idempotency: 'none',
    verify: null,
    transport: 'http',
    support: { status: 'supported' },
  };
}

const CAPS = [cap('a.one'), cap('a.two'), cap('a.write', 'action')];
// Listing tests isolate the upstream; the HTTP-manifest acceptance suite uses a real local server.
const dispatcher: Dispatcher = { dispatch: async (conn, capability) => ok({ message: 'fixture' }, {
  connection_id: conn.id, connection_label: conn.label, capability_id: capability.id, support: { status: 'supported' },
}) };

async function registerCaps(app: FastifyInstance, admin: AdminSession): Promise<void> {
  for (const capability of CAPS) {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/capabilities',
      headers: admin.headers,
      payload: { connector_id: CONNECTOR, capability },
    });
    expect(res.statusCode).toBe(201);
  }
}

async function createConnection(app: FastifyInstance, admin: AdminSession, label: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/connections',
    headers: admin.headers,
    payload: { connector_id: CONNECTOR, label, config: { secret_looking: 'not exposed' } },
  });
  expect(res.statusCode).toBe(201);
  const id = (res.json() as { id: string }).id;
  await app.inject({ method: 'POST', url: `/admin/connections/${id}/verify`, headers: admin.headers });
  return id;
}

async function createClient(app: FastifyInstance, admin: AdminSession, label: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/clients',
    headers: admin.headers,
    payload: { label },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; token: string };
}

async function grant(app: FastifyInstance, admin: AdminSession, clientId: string, connectionId: string, capabilities: string[]) {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/grants',
    headers: admin.headers,
    payload: { client_id: clientId, connection_id: connectionId, capabilities },
  });
  expect(res.statusCode).toBe(201);
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function mcpListConnections(app: FastifyInstance, token: string): Promise<unknown> {
  const headers = { ...bearer(token), 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const initialized = await app.inject({
    method: 'POST', url: '/mcp', headers,
    payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'client-list-test', version: '1' } } },
  });
  if (initialized.statusCode !== 200) {
    expect(initialized.statusCode).toBe(401);
    return initialized.json();
  }
  const session = initialized.headers['mcp-session-id'];
  expect(typeof session).toBe('string');
  const sessionHeaders = { ...headers, 'mcp-session-id': session as string };
  try {
    const res = await app.inject({ method: 'POST', url: '/mcp', headers: sessionHeaders,
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_connections', arguments: {} } } });
    expect(res.statusCode).toBe(200);
    const dataLine = res.body.split('\n').find((line) => line.startsWith('data:'));
    const parsed = JSON.parse(dataLine ? dataLine.slice(5).trimStart() : res.body) as { result: { content: { text: string }[] } };
    return JSON.parse(parsed.result.content[0]!.text);
  } finally { await app.inject({ method: 'DELETE', url: '/mcp', headers: sessionHeaders }); }
}

describe('client-token listing', () => {
  let app: FastifyInstance;
  let cleanupDb: () => void;
  let admin: AdminSession;
  let connA: string;
  let connB: string;
  let connHidden: string;
  let token: string;
  let wildcardToken: string;
  let revokedToken: string;

  beforeAll(async () => {
    const db = tempDbPath();
    cleanupDb = db.cleanup;
    app = (await buildServer({ dbPath: db.path, dispatcher })).app;
    admin = await adminWithStepUp(app);
    await registerCaps(app, admin);
    connA = await createConnection(app, admin, 'A');
    connB = await createConnection(app, admin, 'B');
    connHidden = await createConnection(app, admin, 'Hidden');

    const c1 = await createClient(app, admin, 'explicit');
    token = c1.token;
    await grant(app, admin, c1.id, connA, ['a.one', 'a.write']);
    await grant(app, admin, c1.id, connB, ['a.two']);

    const c2 = await createClient(app, admin, 'wildcard');
    wildcardToken = c2.token;
    await grant(app, admin, c2.id, connA, ['*']);

    const c3 = await createClient(app, admin, 'revoked');
    revokedToken = c3.token;
    await grant(app, admin, c3.id, connA, ['*']);
    await app.inject({ method: 'POST', url: `/admin/clients/${c3.id}/revoke`, headers: admin.headers });
  });

  afterAll(async () => {
    await app.close();
    cleanupDb();
  });

  it('GET /api/connections lists only granted connections, without config', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/connections', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { connections: Record<string, unknown>[] };
    expect(body.connections.map((c) => c['id']).sort()).toEqual([connA, connB].sort());
    expect(body.connections.map((c) => c['id'])).not.toContain(connHidden);
    for (const c of body.connections) expect(c).not.toHaveProperty('config');
    expect(body.connections.find((c) => c['id'] === connA)).toMatchObject({
      connector_id: CONNECTOR,
      label: 'A',
      granted: ['a.one', 'a.write'],
    });
  });

  it('capabilities are limited to the grant', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/connections/${connA}/capabilities`, headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { connection_id: string; capabilities: { id: string }[] };
    expect(body.connection_id).toBe(connA);
    expect(body.capabilities.map((c) => c.id).sort()).toEqual(['a.one', 'a.write']);
  });

  it("'*' lists every query capability but no actions", async () => {
    const res = await app.inject({ method: 'GET', url: `/api/connections/${connA}/capabilities`, headers: bearer(wildcardToken) });
    const body = res.json() as { capabilities: { id: string }[] };
    expect(body.capabilities.map((c) => c.id).sort()).toEqual(['a.one', 'a.two']);
  });

  it('ungranted and unknown connections both answer 404 CONNECTION_NOT_FOUND', async () => {
    for (const id of [connHidden, 'nope']) {
      const res = await app.inject({ method: 'GET', url: `/api/connections/${id}/capabilities`, headers: bearer(token) });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'CONNECTION_NOT_FOUND' } });
    }
  });

  it('missing or unknown token → 401 UNAUTHENTICATED; revoked → 401 CLIENT_REVOKED', async () => {
    for (const url of ['/api/connections', `/api/connections/${connA}/capabilities`]) {
      const missing = await app.inject({ method: 'GET', url });
      expect(missing.statusCode).toBe(401);
      expect(missing.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });

      const unknown = await app.inject({ method: 'GET', url, headers: bearer('deadbeef') });
      expect(unknown.statusCode).toBe(401);
      expect(unknown.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });

      const revoked = await app.inject({ method: 'GET', url, headers: bearer(revokedToken) });
      expect(revoked.statusCode).toBe(401);
      expect(revoked.json()).toMatchObject({ error: { code: 'CLIENT_REVOKED' } });
    }
  });

  it('an admin session is not a client token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/connections', headers: admin.headers });
    expect(res.statusCode).toBe(401);
  });

  it('MCP list_connections returns the same list as GET /api/connections', async () => {
    const rest = await app.inject({ method: 'GET', url: '/api/connections', headers: bearer(token) });
    expect(await mcpListConnections(app, token)).toEqual(rest.json());
  });

  it('MCP initialization refuses a revoked client with HTTP 401', async () => {
    expect(await mcpListConnections(app, revokedToken)).toMatchObject({ error: { code: 'CLIENT_REVOKED' } });
  });

  it('deleting a connection removes it from the listing', async () => {
    const del = await app.inject({ method: 'DELETE', url: `/admin/connections/${connB}`, headers: admin.headers });
    expect(del.statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/api/connections', headers: bearer(token) });
    expect((res.json() as { connections: { id: string }[] }).connections.map((c) => c.id)).toEqual([connA]);
  });
});

describe('state restore across a restart', () => {
  it('old tokens, grants and connections survive a rebuild on the same DB', async () => {
    const db = tempDbPath();
    try {
      // ── first boot ─────────────────────────────────────────────────────
      const first = (await buildServer({ dbPath: db.path, dispatcher })).app;
      const admin = await adminWithStepUp(first);
      await registerCaps(first, admin);
      const connId = await createConnection(first, admin, 'Persisted');
      const client = await createClient(first, admin, 'survivor');
      await grant(first, admin, client.id, connId, ['a.one']);
      // Re-granting the same pair replaces it (used to fail on the primary key).
      await grant(first, admin, client.id, connId, ['a.one', 'a.two']);
      const revoked = await createClient(first, admin, 'gone');
      await grant(first, admin, revoked.id, connId, ['*']);
      await first.inject({ method: 'POST', url: `/admin/clients/${revoked.id}/revoke`, headers: admin.headers });
      await first.close();

      // ── second boot, same DB ───────────────────────────────────────────
      const second = (await buildServer({ dbPath: db.path, dispatcher })).app;
      try {
        // Dynamically registered capabilities live in memory only; YAML
        // connectors would be reloaded from CONNECTORS_DIR instead.
        const admin2 = await adminWithStepUp(second, admin.totpSecret);
        await registerCaps(second, admin2);

        const query = await second.inject({
          method: 'POST',
          url: '/api/invoke',
          headers: bearer(client.token),
          payload: { connection_id: connId, capability_id: 'a.two', input: {}, no_cache: true },
        });
        expect(query.statusCode).toBe(200);
        expect((query.json() as ResultEnvelope).outcome).toBe('success');

        const list = await second.inject({ method: 'GET', url: '/api/connections', headers: bearer(client.token) });
        expect(list.json()).toEqual({
          connections: [{ id: connId, connector_id: CONNECTOR, label: 'Persisted', granted: ['a.one', 'a.two'] }],
        });

        const gone = await second.inject({
          method: 'POST',
          url: '/api/invoke',
          headers: bearer(revoked.token),
          payload: { connection_id: connId, capability_id: 'a.one', input: {} },
        });
        expect(gone.statusCode).toBe(401);
        expect((gone.json() as ResultEnvelope).error?.code).toBe('CLIENT_REVOKED');
      } finally {
        await second.close();
      }
    } finally {
      db.cleanup();
    }
  });
});
