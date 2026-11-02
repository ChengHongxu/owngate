// Admin backend routes — connection/client/grant management
// M0: in-memory maps, no authentication yet (added in M1)
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@webridge/db';
import type { Vault } from '@webridge/vault';
import type { Capability, Connection, Client, Grant } from '@webridge/core';
import { randomBytes, createHash } from 'node:crypto';

interface AdminDeps {
  db: DbClient;
  vault: Vault;
  connectionMap: Map<string, Connection>;
  clientMap: Map<string, Client>;
  grantMap: Map<string, Grant[]>;
  capabilityMap: Map<string, Capability>;
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps) {
  const { connectionMap, clientMap, grantMap, capabilityMap } = deps;

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

  // ── Capabilities (read-only in M0) ─────────────────────────────────────

  app.post<{
    Body: { connector_id: string; capability: Capability };
  }>('/admin/capabilities', async (request, reply) => {
    const key = `${request.body.connector_id}:${request.body.capability.id}`;
    capabilityMap.set(key, request.body.capability);
    return reply.status(201).send({ ok: true, key });
  });

  app.get('/admin/capabilities', async () => {
    return {
      capabilities: Array.from(capabilityMap.entries()).map(([key, cap]) => ({ key, ...cap })),
    };
  });
}
