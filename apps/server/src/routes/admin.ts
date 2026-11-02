// Admin backend routes — connection/client/grant management
// M0: in-memory maps, no authentication yet (added in M1)
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@webridge/db';
import type { Vault } from '@webridge/vault';
import type { Capability, Connection, Client, Grant } from '@webridge/core';
import { randomBytes, createHash } from 'node:crypto';
import type { ConnectorRegistry } from '../registry.js';
import { openBrowserSession, closeBrowserSession, startLogin, stopLogin } from '../dispatchers/browser.js';

interface AdminDeps {
  db: DbClient;
  vault: Vault;
  connectionMap: Map<string, Connection>;
  clientMap: Map<string, Client>;
  grantMap: Map<string, Grant[]>;
  connectorRegistry: ConnectorRegistry;
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
    connectionMap.set(id, conn);
    await deps.db.createConnection({ id, connector_id: conn.connector_id, label: conn.label, config: conn.config });
    return reply.status(201).send(conn);
  });

  app.delete<{ Params: { id: string } }>('/admin/connections/:id', async (request, reply) => {
    if (!connectionMap.has(request.params.id)) return reply.status(404).send({ error: 'Not found' });
    connectionMap.delete(request.params.id);
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
    clientMap.set(id, client);
    await deps.db.createClient({ id, label: client.label, kind: client.kind, token_hash });
    return reply.status(201).send({ ...client, token }); // token shown once
  });

  app.post<{ Params: { id: string } }>('/admin/clients/:id/revoke', async (request, reply) => {
    const client = clientMap.get(request.params.id);
    if (!client) return reply.status(404).send({ error: 'Not found' });
    (client as Client & { revoked: boolean }).revoked = true;
    await deps.db.revokeClient(request.params.id);
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
    const grant: Grant = { client_id, connection_id, capabilities };
    const existing = grantMap.get(client_id) ?? [];
    const idx = existing.findIndex(g => g.connection_id === connection_id);
    if (idx >= 0) existing[idx] = grant; else existing.push(grant);
    grantMap.set(client_id, existing);
    await deps.db.upsertGrant({ client_id, connection_id, capabilities });
    return reply.status(201).send(grant);
  });

  // ── Capabilities ─────────────────────────────────────────────────────

  // Dynamic capability registration (used by tests and runtime additions)
  app.post<{
    Body: { connector_id: string; capability: Capability };
  }>('/admin/capabilities', async (request, reply) => {
    const { connector_id, capability } = request.body
    // Register as a single-capability connector (or merge into existing)
    const existing = connectorRegistry.getManifest(connector_id)
    const caps = existing?.compiled.capabilities ?? {}
    caps[capability.id] = capability
    connectorRegistry.register(connector_id, {
      id: connector_id,
      version: existing?.compiled.version ?? '0.0.0',
      title: existing?.compiled.title ?? connector_id,
      transport: existing?.compiled.transport ?? capability.transport,
      capabilities: caps,
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

  app.post<{
    Body: { connection_id: string; profile_path?: string };
  }>('/admin/browser/open', {
    schema: {
      body: {
        type: 'object',
        required: ['connection_id'],
        properties: {
          connection_id: { type: 'string' },
          profile_path: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const conn = connectionMap.get(request.body.connection_id)
    if (!conn) return reply.status(404).send({ error: 'Connection not found' })
    const profilePath = request.body.profile_path ?? `/profiles/${conn.id}`
    try {
      const result = await openBrowserSession(conn.id, profilePath)
      return reply.status(201).send(result)
    } catch (e) {
      return reply.status(502).send({ error: (e as Error).message })
    }
  })

  app.post<{ Params: { id: string } }>('/admin/browser/:id/close', async (request, reply) => {
    try {
      await closeBrowserSession(request.params.id)
      return reply.send({ ok: true })
    } catch (e) {
      return reply.status(502).send({ error: (e as Error).message })
    }
  })

  app.post<{
    Body: { connection_id: string; url: string; qr_selector?: string };
  }>('/admin/login/start', {
    schema: {
      body: {
        type: 'object',
        required: ['connection_id', 'url'],
        properties: {
          connection_id: { type: 'string' },
          url: { type: 'string' },
          qr_selector: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const result = await startLogin(
        request.body.connection_id,
        request.body.url,
        request.body.qr_selector,
      )
      return reply.status(201).send(result)
    } catch (e) {
      return reply.status(502).send({ error: (e as Error).message })
    }
  })

  app.post<{ Params: { id: string } }>('/admin/login/:id/stop', async (request, reply) => {
    try {
      await stopLogin(request.params.id)
      return reply.send({ ok: true })
    } catch (e) {
      return reply.status(502).send({ error: (e as Error).message })
    }
  })
}
