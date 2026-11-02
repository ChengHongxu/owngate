// Admin backend routes — connection/client/grant management.
// Authentication is not done here: main.ts installs createAdminGate()
// (auth/guard.ts) on the root instance, which requires an admin session for
// every /admin/* route and step-up for the ones in STEP_UP_ROUTES (§8.4).
// The in-memory maps are the read path for invoke(); the DB is written first
// and main.ts reloads the maps from it at startup.
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@webridge/db';
import type { Vault } from '@webridge/vault';
import type { Capability, Connection, Client, Grant } from '@webridge/core';
import { randomBytes, createHash } from 'node:crypto';
import type { ConnectorRegistry } from '../registry.js';
import type { BrowserClient, CookieItem } from '../browser-client.js';

interface AdminDeps {
  db: DbClient;
  vault: Vault;
  connectionMap: Map<string, Connection>;
  clientMap: Map<string, Client>;
  grantMap: Map<string, Grant[]>;
  connectorRegistry: ConnectorRegistry;
  browserClient: BrowserClient;
  audit: (entry: { action: string; target?: string; detail?: unknown; client_id?: string }) => void;
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps) {
  const { connectionMap, clientMap, grantMap, connectorRegistry } = deps;

  // ── Connections ────────────────────────────────────────────────────────

  app.get('/admin/connections', async () => {
    return { connections: Array.from(connectionMap.values()) };
  });

  app.post<{
    Body: { connector_id: string; label: string; config: Record<string, unknown> };
  }>('/admin/connections', {
    schema: {
      body: {
        type: 'object',
        required: ['connector_id', 'label', 'config'],
        properties: {
          connector_id: { type: 'string' },
          label: { type: 'string' },
          config: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const id = randomBytes(8).toString('hex');
    const now = new Date().toISOString();

    // Ensure connector row exists (foreign key requires it)
    await deps.db.upsertConnector({
      id: request.body.connector_id,
      version: '0.0.0',
      title: request.body.connector_id,
      transport: 'http',
      manifest: {},
    });

    const conn: Connection = {
      id,
      connector_id: request.body.connector_id,
      label: request.body.label,
      config: request.body.config,
      capability_states: {},
      created_at: now,
      updated_at: now,
    };
    await deps.db.createConnection({ id, connector_id: conn.connector_id, label: conn.label, config: conn.config });
    connectionMap.set(id, conn);
    return reply.status(201).send(conn);
  });

  app.delete<{ Params: { id: string } }>('/admin/connections/:id', async (request, reply) => {
    const { id } = request.params;
    if (!connectionMap.has(id)) return reply.status(404).send({ error: 'Not found' });
    // Grants and credentials cascade in the DB; mirror that in memory so the
    // connection does not come back at the next restart.
    await deps.db.deleteConnection(id);
    connectionMap.delete(id);
    for (const [clientId, grants] of grantMap) {
      const kept = grants.filter((g) => g.connection_id !== id);
      if (kept.length !== grants.length) grantMap.set(clientId, kept);
    }
    return reply.send({ ok: true });
  });

  // ── Clients ────────────────────────────────────────────────────────────

  app.post<{
    Body: { label: string; kind: 'mcp' | 'cli' | 'cron' };
  }>('/admin/clients', {
    schema: {
      body: {
        type: 'object',
        required: ['label', 'kind'],
        properties: {
          label: { type: 'string' },
          kind: { type: 'string', enum: ['mcp', 'cli', 'cron'] },
        },
      },
    },
  }, async (request, reply) => {
    const id = randomBytes(8).toString('hex');
    const token = randomBytes(32).toString('hex');
    const token_hash = createHash('sha256').update(token).digest('hex');
    const now = new Date().toISOString();
    const client: Client & { token_hash: string } = {
      id,
      label: request.body.label,
      kind: request.body.kind,
      token_hash,
      revoked: false,
      created_at: now,
    };
    await deps.db.createClient({ id, label: client.label, kind: client.kind, token_hash });
    clientMap.set(id, client);
    return reply.status(201).send({ ...client, token }); // token shown once
  });

  app.post<{ Params: { id: string } }>('/admin/clients/:id/revoke', async (request, reply) => {
    const client = clientMap.get(request.params.id);
    if (!client) return reply.status(404).send({ error: 'Not found' });
    await deps.db.revokeClient(request.params.id);
    client.revoked = true;
    return reply.send({ ok: true });
  });

  // ── Grants ─────────────────────────────────────────────────────────────

  app.post<{
    Body: { client_id: string; connection_id: string; capabilities: string[] };
  }>('/admin/grants', {
    schema: {
      body: {
        type: 'object',
        required: ['client_id', 'connection_id', 'capabilities'],
        properties: {
          client_id: { type: 'string' },
          connection_id: { type: 'string' },
          capabilities: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const { client_id, connection_id, capabilities } = request.body;
    if (!clientMap.has(client_id)) return reply.status(404).send({ error: 'Client not found' });
    if (!connectionMap.has(connection_id)) return reply.status(404).send({ error: 'Connection not found' });
    const grant: Grant = { client_id, connection_id, capabilities };
    await deps.db.upsertGrant({ client_id, connection_id, capabilities });
    const existing = grantMap.get(client_id) ?? [];
    const idx = existing.findIndex(g => g.connection_id === connection_id);
    if (idx >= 0) existing[idx] = grant; else existing.push(grant);
    grantMap.set(client_id, existing);
    return reply.status(201).send(grant);
  });

  // ── Capabilities ─────────────────────────────────────────────────────

  // Dynamic capability registration (used by tests and runtime additions)
  app.post<{
    Body: { connector_id: string; capability: Capability };
  }>('/admin/capabilities', async (request, reply) => {
    const { connector_id, capability } = request.body
    // Merge into the existing connector, keeping every compiled field (login
    // in particular); only the capabilities map changes. A new connector id
    // becomes a single-capability connector.
    const existing = connectorRegistry.getManifest(connector_id)?.compiled
    const capabilities = { ...(existing?.capabilities ?? {}), [capability.id]: capability }
    connectorRegistry.register(connector_id, existing !== undefined
      ? { ...existing, capabilities }
      : {
          id: connector_id,
          version: '0.0.0',
          title: connector_id,
          transport: capability.transport,
          capabilities,
        })
    return reply.status(201).send({ ok: true, key: `${connector_id}:${capability.id}` })
  })

  app.get('/admin/capabilities', async (request, reply) => {
    const connectorId = (request.query as { connector_id?: string })['connector_id']
    if (connectorId) {
      const caps = connectorRegistry.listCapabilities(connectorId)
      return { capabilities: caps }
    }
    return { capabilities: [] }
  })

  // ── Browser sessions & login (M1) ────────────────────────────────────

  // The worker allocates the profile, display and proxy credentials from the
  // connection id (§13.1); the server never names a profile path.
  app.post<{
    Body: { connection_id: string };
  }>('/admin/browser/open', {
    schema: {
      body: {
        type: 'object',
        required: ['connection_id'],
        additionalProperties: false,
        properties: {
          connection_id: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const conn = connectionMap.get(request.body.connection_id);
    if (!conn) return reply.status(404).send({ error: 'Connection not found' });
    try {
      const result = await deps.browserClient.openSession(conn.id);
      return reply.status(201).send(result);
    } catch (e) {
      return reply.status(502).send({ error: (e as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>('/admin/browser/:id/close', async (request, reply) => {
    try {
      await deps.browserClient.closeSession(request.params.id);
      return reply.send({ ok: true });
    } catch (e) {
      return reply.status(502).send({ error: (e as Error).message });
    }
  });

  // ── POST /admin/connections/:connectionId/cookies (二次验证) ───────────

  app.post<{
    Params: { connectionId: string };
    Body: { cookies: CookieItem[] };
  }>('/admin/connections/:connectionId/cookies', {
    schema: {
      body: {
        type: 'object',
        required: ['cookies'],
        properties: {
          cookies: { type: 'array', items: { type: 'object' } },
        },
      },
    },
  }, async (request, reply) => {
    const { connectionId } = request.params;
    const conn = connectionMap.get(connectionId);
    if (!conn) return reply.status(404).send({ error: 'CONNECTION_NOT_FOUND', what_happened: '连接不存在' });

    const login = deps.connectorRegistry.getLogin(conn.connector_id);
    if (!login) {
      return reply.status(400).send({
        error: 'CAPABILITY_UNSUPPORTED',
        what_happened: '该连接没有 login 段，不支持 cookie 导入',
      });
    }

    try {
      const result = await deps.browserClient.importCookies(connectionId, request.body.cookies, login.successWhen);
      // Audit: record only name/domain, NEVER the value (design §8.4).
      deps.audit({
        action: 'cookies.import',
        target: connectionId,
        detail: { cookies: result.cookies, logged_in: result.logged_in },
      });
      return result;
    } catch (e) {
      return reply.status(502).send({ error: (e as Error).message });
    }
  });
}
