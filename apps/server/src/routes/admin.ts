// Admin backend routes — connection/client/grant management.
// Authentication is not done here: main.ts installs createAdminGate()
// (auth/guard.ts) on the root instance, which requires an admin session for
// every /admin/* route and step-up for the ones in STEP_UP_ROUTES (§8.4).
// The in-memory maps are the read path for invoke(); the DB is written first
// and main.ts reloads the maps from it at startup.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DbClient } from '@owngate/db';
import type { Vault, SecretRedactor } from '@owngate/vault';
import { vaultContext } from '@owngate/vault';
import type { Capability, ComparisonView, Connection, Client, Grant, InvokeRequest, ResultEnvelope, SupportState } from '@owngate/core';
import { randomBytes, createHash } from 'node:crypto';
import type { ConnectorRegistry } from '../registry.js';
import type { BrowserClient, CookieItem } from '../browser-client.js';
import { egressPolicy } from '../egress-policy.js';
import type { ConnectionVerifier } from '../verification.js';
import { connectionView, effectiveCapabilityState } from '../connection-status.js';

function normalizeConfig(input: Record<string, unknown>, schema?: Record<string, unknown>): Record<string, unknown> {
  if (!schema) return { ...input };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input)) if (!(key in schema)) throw new Error(`Unknown configuration field: ${key}`);
  for (const [key, raw] of Object.entries(schema)) {
    const field = raw as { type?: string; default?: unknown; required?: boolean; format?: string; minimum?: number; enum?: unknown[] };
    let value = input[key] ?? field.default;
    if (value === undefined || value === '') {
      if (field.required) throw new Error(`Missing configuration field: ${key}`);
      continue;
    }
    if (field.type === 'number' || field.type === 'integer') {
      if (typeof value === 'string') value = Number(value);
      if (typeof value !== 'number' || !Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value))) throw new Error(`${key} must be a ${field.type}`);
      if (field.minimum !== undefined && value < field.minimum) throw new Error(`${key} must be at least ${field.minimum}`);
    } else if (field.type === 'string') {
      if (typeof value !== 'string') throw new Error(`${key} must be a string`);
      value = value.trim();
      if (!value) {
        if (field.required) throw new Error(`Missing configuration field: ${key}`);
        continue;
      }
    } else if (field.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
    if (field.format === 'uri') {
      let parsed: URL;
      try { parsed = new URL(String(value)); } catch { throw new Error(`${key} must be a valid URL`); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`${key} must be an HTTP URL without credentials`);
      value = parsed.href.replace(/\/$/, '');
    }
    if (field.enum && !field.enum.includes(value)) throw new Error(`${key} is not an allowed value`);
    out[key] = value;
  }
  return out;
}

interface AdminDeps {
  db: DbClient;
  vault: Vault;
  connectionMap: Map<string, Connection>;
  clientMap: Map<string, Client>;
  grantMap: Map<string, Grant[]>;
  connectorRegistry: ConnectorRegistry;
  browserClient: BrowserClient;
  secrets: SecretRedactor;
  invalidateCache: () => void | Promise<void>;
  getAdminUserId: (request: FastifyRequest) => Promise<string | null>;
  invoke: (request: InvokeRequest, userId: string, verify?: boolean) => Promise<ResultEnvelope>;
  verifier: ConnectionVerifier;
  audit: (entry: { action: string; target?: string; detail?: unknown; client_id?: string }) => void;
  cancelConnection?: (id: string) => Promise<unknown>;
  notifyChanged?: (clientId?: string) => Promise<void>;
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps) {
  const { connectionMap, clientMap, grantMap, connectorRegistry } = deps;

  const persistStates = async (connection: Connection, states: Record<string, SupportState>) => {
    const now = new Date(Math.max(Date.now(), (Date.parse(connection.updated_at) || 0) + 1)).toISOString();
    await deps.db.updateConnectionStates(connection.id, states, now);
    connection.capability_states = states;
    connection.updated_at = now;
    await deps.notifyChanged?.();
  };
  const verifyConnection = (connection: Connection, userId: string, selected?: { capability_id: string; input?: unknown }) => deps.verifier.verify(connection.id, userId, selected);

  // ── Connections ────────────────────────────────────────────────────────

  app.get('/admin/connections', async () => {
    return { connections: Array.from(connectionMap.values(), connection => connectionView(connection, connectorRegistry)) };
  });

  // ── List connectors ────────────────────────────────────────────────────
  app.get('/admin/connectors', async () => {
    const connectors: Array<{
      id: string;
      title: string;
      transport: string;
      has_auth: boolean;
      has_login: boolean;
      views?: ComparisonView[];
      config?: Record<string, unknown>;
      auth?: { type: string; fields?: Record<string, unknown> };
    }> = [];
    for (const entry of connectorRegistry.listManifests()) {
      connectors.push({
        id: entry.compiled.id,
        title: entry.compiled.title,
        transport: entry.compiled.transport,
        has_auth: entry.compiled.auth !== undefined,
        has_login: entry.compiled.login !== undefined,
        ...(entry.compiled.views !== undefined ? { views: entry.compiled.views } : {}),
        ...(entry.compiled.config !== undefined ? { config: entry.compiled.config } : {}),
        ...(entry.compiled.auth !== undefined ? { auth: entry.compiled.auth } : {}),
      });
    }
    return { connectors };
  });

  app.post<{
    Body: { connector_id: string; label: string; config: Record<string, unknown>; scope?: 'personal' | 'organization'; confirm_organization?: boolean; tags?: string[] };
  }>('/admin/connections', {
    schema: {
      body: {
        type: 'object',
        required: ['connector_id', 'label', 'config'],
        additionalProperties: false,
        properties: {
          connector_id: { type: 'string' },
          label: { type: 'string', minLength: 1, maxLength: 100 },
          config: { type: 'object' },
          scope: { type: 'string', enum: ['personal', 'organization'] },
          confirm_organization: { type: 'boolean' },
          tags: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 40 } },
        },
      },
    },
  }, async (request, reply) => {
    const id = randomBytes(8).toString('hex');
    const now = new Date().toISOString();

    // Check if connector exists and requires auth
    const manifest = connectorRegistry.getManifest(request.body.connector_id);
    if (!manifest) {
      return reply.status(400).send({ error: 'Unknown connector', code: 'UNKNOWN_CONNECTOR' });
    }
    if (request.body.scope === 'organization' && request.body.confirm_organization !== true) return reply.status(400).send({ code: 'ORGANIZATION_CONFIRMATION_REQUIRED', error: '请确认有权接入此组织账户' });
    let config: Record<string, unknown>;
    try { config = normalizeConfig(request.body.config, manifest.compiled.config); }
    catch (error) { return reply.status(400).send({ code: 'INVALID_PARAMS', error: (error as Error).message }); }

    // Ensure connector row exists (foreign key requires it)
    if ((await deps.db.rawQuery('SELECT id FROM connectors WHERE id=?', [request.body.connector_id])).length === 0) await deps.db.upsertConnector({
      id: request.body.connector_id, version: manifest.compiled.version, title: manifest.compiled.title, transport: manifest.compiled.transport, manifest: {},
    });

    // No network evidence exists yet. Authentication and adapter failures are
    // recorded only after an actual query or authentication check.
    const capability_states: Record<string, SupportState> = {};
    const conn: Connection = {
      id,
      connector_id: request.body.connector_id,
      label: request.body.label,
      config,
      capability_states,
      created_at: now,
      updated_at: now,
      paused: false,
      scope: request.body.scope ?? 'personal',
      tags: [...new Set(request.body.tags ?? [])],
    };
    for (const cap of connectorRegistry.listCapabilities(conn.connector_id, conn)) {
      capability_states[cap.id] = cap.kind === 'action' || cap.support.status === 'disabled' ? { status: 'disabled' }
        : cap.support.status === 'unsupported' ? { ...cap.support } : { status: 'unverified' };
    }
    await deps.db.createConnection({ id, connector_id: conn.connector_id, label: conn.label, config: conn.config, capability_states, scope: conn.scope!, tags: conn.tags! });
    await deps.db.updateConnectionStates(id, capability_states, now);
    connectionMap.set(id, conn);
    await deps.audit({ action: 'connection.created', target: id, detail: { connector_id: conn.connector_id, scope: conn.scope, tags: conn.tags } });
    await deps.notifyChanged?.();
    return reply.status(201).send(connectionView(conn, connectorRegistry));
  });

  app.delete<{ Params: { id: string } }>('/admin/connections/:id', async (request, reply) => {
    const { id } = request.params;
    if (!connectionMap.has(id)) return reply.status(404).send({ error: 'Not found' });
    await deps.cancelConnection?.(id);
    // Grants and credentials cascade in the DB; mirror that in memory so the
    // connection does not come back at the next restart.
    await deps.db.deleteConnection(id);
    connectionMap.delete(id);
    await deps.browserClient.closeSession(id).catch(() => undefined);
    connectorRegistry.clearCredentials(id);
    deps.secrets.unregister(id);
    await deps.invalidateCache();
    for (const [clientId, grants] of grantMap) {
      const kept = grants.filter((g) => g.connection_id !== id);
      if (kept.length !== grants.length) grantMap.set(clientId, kept);
    }
    await deps.audit({ action: 'connection.deleted', target: id });
    await deps.notifyChanged?.();
    return reply.send({ ok: true });
  });

  app.patch<{ Params: { id: string }; Body: { config: Record<string, unknown>; label?: string } }>('/admin/connections/:id', {
    schema: { body: { type: 'object', required: ['config'], additionalProperties: false,
      properties: { config: { type: 'object' }, label: { type: 'string', minLength: 1 } } } },
  }, async (request, reply) => {
    const conn = connectionMap.get(request.params.id);
    if (!conn) return reply.status(404).send({ code: 'CONNECTION_NOT_FOUND' });
    const manifest = connectorRegistry.getManifest(conn.connector_id);
    let config: Record<string, unknown>;
    try { config = normalizeConfig(request.body.config, manifest?.compiled.config); }
    catch (error) { return reply.status(400).send({ code: 'INVALID_PARAMS', error: (error as Error).message }); }
    // Changing a destination must not silently send existing credentials to it.
    if (config['base_url'] !== conn.config['base_url']) {
      await deps.db.deleteCredentials(conn.id);
      connectorRegistry.clearCredentials(conn.id);
      deps.secrets.unregister(conn.id);
    }
    await deps.db.updateConnectionConfig(conn.id, config, request.body.label);
    conn.config = config;
    if (request.body.label !== undefined) conn.label = request.body.label;
    const states = Object.fromEntries(connectorRegistry.listCapabilities(conn.connector_id, conn).map((cap) => [cap.id,
      cap.kind === 'action' || cap.support.status === 'disabled' || conn.capability_states[cap.id]?.status === 'disabled' ? { status: 'disabled' as const }
        : cap.support.status === 'unsupported' || conn.capability_states[cap.id]?.status === 'unsupported' ? { status: 'unsupported' as const } : { status: 'unverified' as const }]));
    await persistStates(conn, states);
    await deps.invalidateCache();
    return connectionView(conn, connectorRegistry);
  });

  app.post<{ Params: { id: string }; Body?: { capability_id: string; input?: unknown } }>('/admin/connections/:id/verify', async (request, reply) => {
    const userId = await deps.getAdminUserId(request);
    if (!userId) return reply.status(401).send({ code: 'NO_SESSION' });
    const conn = connectionMap.get(request.params.id);
    if (!conn) return reply.status(404).send({ code: 'CONNECTION_NOT_FOUND' });
    const selected = request.body;
    const capability = selected && typeof selected.capability_id === 'string' ? connectorRegistry.getCapability(conn.connector_id, selected.capability_id, conn) : undefined;
    if (selected && (!capability || capability.kind !== 'query' || capability.effect !== 'read')) return reply.status(400).send({ code: 'INVALID_PARAMS', error: '请选择当前连接可用的只读查询能力' });
    return verifyConnection(conn, userId, selected);
  });

  // ── Connection credentials ─────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/admin/connections/:id/credentials', async (request, reply) => {
    const { id } = request.params;
    const conn = connectionMap.get(id);
    if (!conn) return reply.status(404).send({ error: 'Connection not found' });

    const rows = await deps.db.listCredentials(id);
    const fields = rows.map((r) => ({ key: r.key, updated_at: r.updated_at }));
    return { fields };
  });

  app.put<{
    Params: { id: string };
    Body: { credentials: Record<string, string> };
  }>('/admin/connections/:id/credentials', {
    schema: {
      body: {
        type: 'object',
        required: ['credentials'],
        properties: {
          credentials: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const conn = connectionMap.get(id);
    if (!conn) return reply.status(404).send({ error: 'Connection not found' });

    const manifest = connectorRegistry.getManifest(conn.connector_id);
    if (!manifest?.compiled.auth) {
      return reply.status(400).send({ error: 'Connector does not require credentials' });
    }

    const merged = { ...(connectorRegistry.getCredentials(id) ?? {}), ...request.body.credentials };
    for (const [key, value] of Object.entries(request.body.credentials)) {
      if (!(key in (manifest.compiled.auth.fields ?? {})) || typeof value !== 'string' || !value.trim()) {
        return reply.status(400).send({ code: 'INVALID_PARAMS', error: `Invalid credential field: ${key}` });
      }
    }
    for (const [key, field] of Object.entries(manifest.compiled.auth.fields ?? {})) {
      if ((field as { required?: boolean }).required !== false && !merged[key]?.trim()) {
        return reply.status(400).send({ code: 'INVALID_PARAMS', error: `Missing credential: ${key}` });
      }
    }
    const userId = await deps.getAdminUserId(request);
    if (!userId) return reply.status(401).send({ code: 'NO_SESSION' });
    const pending = { ...conn.capability_states };
    for (const cap of connectorRegistry.listCapabilities(conn.connector_id, conn)) {
      if (cap.kind === 'query' && !['disabled', 'unsupported'].includes((pending[cap.id] ?? cap.support).status)) pending[cap.id] = { status: 'unverified' };
    }
    await persistStates(conn, pending);
    await deps.invalidateCache();

    // Validate every field before writing any encrypted values.
    for (const [key, value] of Object.entries(request.body.credentials)) {
      if (typeof value !== 'string') {
        return reply.status(400).send({ error: `Credential "${key}" must be a string` });
      }
      const encrypted = deps.vault.encrypt(value, vaultContext.credential(id, key));
      await deps.db.upsertCredential({
        connection_id: id,
        key,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        auth_tag: encrypted.auth_tag,
      });
    }

    // Load into registry
    const existing = connectorRegistry.getCredentials(id) ?? {};
    for (const [key, value] of Object.entries(request.body.credentials)) {
      existing[key] = value;
    }
    connectorRegistry.setCredentials(id, existing);
    deps.secrets.register(id, Object.entries(existing)
      .filter(([key]) => (manifest.compiled.auth?.fields?.[key] as { secret?: boolean } | undefined)?.secret !== false)
      .map(([, value]) => value));

    return reply.send({ ok: true, ...(await verifyConnection(conn, userId)) });
  });

  // ── Clients ────────────────────────────────────────────────────────────

  app.get('/admin/clients', async () => ({ clients: [...clientMap.values()].map(({ id, label, revoked, created_at, expires_at }) => ({ id, label, revoked, created_at, expires_at: expires_at ?? null })) }));
  app.get('/admin/grants', async () => ({ grants: [...grantMap.values()].flat() }));

  app.post<{
    Body: { label: string; expires_at?: string | null };
  }>('/admin/clients', {
    schema: {
      body: {
        type: 'object',
        required: ['label'],
        additionalProperties: false,
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 100 },
          expires_at: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
    },
  }, async (request, reply) => {
    const requestedExpiry = request.body.expires_at;
    if (requestedExpiry && !(Date.parse(requestedExpiry) > Date.now())) return reply.status(400).send({ code: 'INVALID_PARAMS', error: '有效期应为未来的日期时间' });
    const id = randomBytes(8).toString('hex');
    const token = randomBytes(32).toString('hex');
    const token_hash = createHash('sha256').update(token).digest('hex');
    const now = new Date().toISOString();
    const client: Client & { token_hash: string } = {
      id,
      label: request.body.label,
      token_hash,
      revoked: false,
      created_at: now,
      expires_at: requestedExpiry ? new Date(requestedExpiry).toISOString() : null,
    };
    await deps.db.createClient({ id, label: client.label, token_hash, expires_at: client.expires_at ?? null });
    clientMap.set(id, client);
    await deps.audit({ action: 'client.created', target: id, detail: { expires_at: client.expires_at } });
    return reply.status(201).send({ id, label: client.label, revoked: client.revoked, created_at: now, expires_at: client.expires_at, token }); // token shown once
  });

  app.post<{ Params: { id: string } }>('/admin/clients/:id/revoke', async (request, reply) => {
    const client = clientMap.get(request.params.id);
    if (!client) return reply.status(404).send({ error: 'Not found' });
    await deps.db.revokeClient(request.params.id);
    client.revoked = true;
    await deps.invalidateCache();
    await deps.audit({ action: 'client.revoked', target: client.id });
    await deps.notifyChanged?.(client.id);
    return reply.send({ ok: true });
  });

  // ── Grants ─────────────────────────────────────────────────────────────

  app.post<{
    Body: { client_id: string; connection_id: string; capabilities: string[]; visibility?: Grant['visibility'] };
  }>('/admin/grants', {
    schema: {
      body: {
        type: 'object',
        required: ['client_id', 'connection_id', 'capabilities'],
        additionalProperties: false,
        properties: {
          client_id: { type: 'string' },
          connection_id: { type: 'string' },
          capabilities: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string' } },
          visibility: { type: 'object', additionalProperties: false, properties: { pii: { type: 'boolean' }, financial: { type: 'boolean' }, content: { type: 'boolean' } } },
        },
      },
    },
  }, async (request, reply) => {
    const { client_id, connection_id, capabilities, visibility } = request.body;
    const client = clientMap.get(client_id);
    if (!client) return reply.status(404).send({ error: 'Client not found' });
    if (client.revoked) return reply.status(409).send({ code: 'CLIENT_REVOKED', error: 'Revoked clients cannot receive grants' });
    const connection = connectionMap.get(connection_id);
    if (!connection) return reply.status(404).send({ error: 'Connection not found' });
    const allowed = connectorRegistry.listCapabilities(connection.connector_id, connection);
    if (capabilities.some((id) => id !== '*' && !allowed.some((cap) => cap.id === id || (cap.kind === 'action' && id === `propose:${cap.id}`)))) return reply.status(400).send({ code: 'INVALID_PARAMS', error: '包含当前连接不存在或不可授权的能力' });
    const grant: Grant = { client_id, connection_id, capabilities, ...(visibility !== undefined ? { visibility } : {}) };
    await deps.db.upsertGrant({ client_id, connection_id, capabilities, ...(visibility !== undefined ? { visibility } : {}) });
    const existing = grantMap.get(client_id) ?? [];
    const idx = existing.findIndex(g => g.connection_id === connection_id);
    if (idx >= 0) existing[idx] = grant; else existing.push(grant);
    grantMap.set(client_id, existing);
    await deps.audit({ action: 'grant.updated', target: connection_id, client_id, detail: { capabilities, visibility: visibility ?? 'default' } });
    await deps.notifyChanged?.(client_id);
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
    await deps.notifyChanged?.()
    return reply.status(201).send({ ok: true, key: `${connector_id}:${capability.id}` })
  })

  app.get('/admin/capabilities', async (request, reply) => {
    const query = request.query as { connector_id?: string; connection_id?: string }
    const connection = query.connection_id ? connectionMap.get(query.connection_id) : undefined
    if (query.connection_id && !connection) return reply.status(404).send({ code: 'CONNECTION_NOT_FOUND' })
    const connectorId = connection?.connector_id ?? query.connector_id
    if (connectorId) {
      const caps = connectorRegistry.listCapabilities(connectorId, connection)
      return { capabilities: caps.map((cap) => connection ? { ...cap, support: effectiveCapabilityState(cap, connection.capability_states[cap.id]) } : cap) }
    }
    return { capabilities: [] }
  })

  // Admin identity is resolved from the session; all execution uses invoke().
  app.post<{
    Body: { connection_id: string; capability_id: string; input?: unknown; no_cache?: boolean };
  }>('/admin/invoke', {
    schema: {
      body: {
        type: 'object',
        required: ['connection_id', 'capability_id'],
        additionalProperties: false,
        properties: {
          connection_id: { type: 'string' },
          capability_id: { type: 'string' },
          input: {},
          no_cache: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = await deps.getAdminUserId(request);
    if (!userId) return reply.status(401).send({ code: 'NO_SESSION' });
    return deps.invoke({ connection_id: request.body.connection_id, capability_id: request.body.capability_id,
      input: request.body.input ?? {}, ...(request.body.no_cache !== undefined ? { no_cache: request.body.no_cache } : {}) }, userId);
  });

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
      const result = await deps.browserClient.openSession(conn.id, egressPolicy(conn, connectorRegistry));
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
      const revision = conn.updated_at;
      const result = await deps.browserClient.importCookies(connectionId, request.body.cookies, login.successWhen, egressPolicy(conn, connectorRegistry));
      // Audit: record only name/domain, NEVER the value (design §8.4).
      deps.audit({
        action: 'cookies.import',
        target: connectionId,
        detail: { cookies: result.cookies, logged_in: result.logged_in },
      });
      // Imported cookies invalidate prior observations. Cookie presence alone
      // does not establish that a server-side authenticated query will succeed.
      if (connectionMap.get(connectionId) === conn && conn.updated_at === revision) await deps.verifier.loginCompleted(connectionId);
      await deps.invalidateCache();
      return result;
    } catch (e) {
      return reply.status(502).send({ error: (e as Error).message });
    }
  });
}
