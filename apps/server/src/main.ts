// apps/server entry point — wires all packages together and exposes three
// entry points: REST, MCP (Streamable HTTP), and the admin backend.

import Fastify from 'fastify';
import type { RouteOptions } from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DbClient, acquireDbLease } from '@owngate/db';
import { Vault, vaultContext, migrateEncryptedRecords } from '@owngate/vault';
import { redact, SecretRedactor } from '@owngate/vault';
import type {
  InvokeServices, InvokeOptions,
  CapabilityRegistry, ConnectionStore, AuthStore,
  CacheStore, AuditStore, CachedResult,
  Dispatcher,
} from '@owngate/core';
import { invoke, reserveInvocationSequence } from '@owngate/core';
import type { Capability, Connection, Client, Grant, SupportState } from '@owngate/core';
import { registerMcpRoutes } from './routes/mcp.js';
import type { McpController } from './routes/mcp.js';
import { registerRestRoutes } from './routes/rest.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerScreenRoutes } from './routes/screen.js';
import { registerClientApiRoutes } from './routes/client-api.js';
import { registerProbeRoutes } from './routes/probe.js';
import { createAuthService } from './auth/service.js';
import { SESSION_COOKIE, createAdminGate } from './auth/guard.js';
import { createBrowserClient } from './browser-client.js';
import type { BrowserClient } from './browser-client.js';
import { ConnectorRegistry } from './registry.js';
import { UnifiedDispatcher } from './dispatchers/index.js';
import { ProbeScheduler, DEFAULT_PROBE_INTERVAL_MS } from './probe/scheduler.js';
import type { ProbeTarget } from './probe/scheduler.js';
import { createStateWriter } from './state-writer.js';
import type { StateWriterFn } from './state-writer.js';
import { readSecret } from './secrets.js';
import { TaskService } from './tasks/service.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { MonitorService } from './monitors/service.js';
import { registerMonitorRoutes } from './routes/monitors.js';
import { ActionService } from './actions/service.js';
import { registerActionRoutes } from './routes/actions.js';
import { registerProductRoutes } from './routes/product.js';
import { egressPolicy } from './egress-policy.js';
import { ExecutionLimits } from './execution-limits.js';
import { ComparisonService } from './comparisons/service.js';
import { registerComparisonRoutes } from './routes/comparisons.js';
import { ConnectionVerifier } from './verification.js';
import { IsolatedHttpRuntime } from './http-runtime.js';
import { ExtensionService } from './extensions/service.js';
import { registerExtensionRoutes } from './routes/extensions.js';
import { invokeAdminWithTrace } from './execution-trace.js';
import { normalizeCapabilityStates } from './connection-status.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const DB_PATH = process.env['DB_PATH'] ?? './owngate.db';
const LOG_LEVEL = process.env['LOG_LEVEL'] ?? 'info';
const PROBE_INTERVAL_MS = parseInt(process.env['OWNGATE_PROBE_INTERVAL_MS'] ?? '', 10) || DEFAULT_PROBE_INTERVAL_MS;

// Master key resolution: env var → file path env var → ephemeral (dev only)
function resolveMasterKey(): string {
  if (process.env['MASTER_KEY_HEX']) return process.env['MASTER_KEY_HEX'];
  const keyFile = process.env['MASTER_KEY_HEX_FILE'];
  if (keyFile) {
    try {
      return readFileSync(keyFile, 'utf8').trim();
    } catch (e) {
      console.error(`[FATAL] Cannot read MASTER_KEY_HEX_FILE at ${keyFile}:`, (e as Error).message);
      process.exit(1);
    }
  }
  if (process.env['NODE_ENV'] === 'production') throw new Error('Production requires MASTER_KEY_HEX or MASTER_KEY_HEX_FILE');
  console.warn('[WARN] MASTER_KEY_HEX not set — using ephemeral key. Data will be lost on restart.');
  return randomBytes(32).toString('hex');
}

const MASTER_KEY = resolveMasterKey();

// ── Startup restore ────────────────────────────────────────────────────────

/**
 * JSON columns come back parsed from drizzle, but rows written before the
 * schema default was fixed hold a JSON string ('"{}"'), so parse once more.
 */
function jsonColumn(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  const v = jsonColumn(value);
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] {
  const v = jsonColumn(value);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Fill the in-memory maps that invoke() reads from the DB, so client tokens,
 * grants and connections survive a restart. Revoked clients are loaded too:
 * invoke() needs them to answer CLIENT_REVOKED instead of UNAUTHENTICATED.
 */
async function restoreState(
  db: DbClient,
  connectionMap: Map<string, Connection>,
  clientMap: Map<string, Client>,
  grantMap: Map<string, Grant[]>,
  vault: Vault,
  connectorRegistry: ConnectorRegistry,
): Promise<void> {
  const [connections, clients, grants] = await Promise.all([
    db.listConnections(),
    db.listClients(),
    db.listGrants(),
  ]);
  for (const row of connections) {
    const connection: Connection = {
      id: row.id,
      connector_id: row.connector_id,
      label: row.label,
      config: asRecord(row.config),
      capability_states: asRecord(row.capability_states) as Record<string, SupportState>,
      created_at: row.created_at,
      updated_at: row.updated_at,
      paused: row.paused,
      scope: row.scope as 'personal' | 'organization',
      tags: asStringArray(row.tags),
    };
    const normalized = normalizeCapabilityStates(connection, connectorRegistry);
    if (JSON.stringify(normalized) !== JSON.stringify(connection.capability_states)) {
      await db.updateConnectionStates(connection.id, normalized, connection.updated_at);
      connection.capability_states = normalized;
    }
    connectionMap.set(row.id, connection);
  }
  for (const row of clients) {
    const client: Client & { token_hash: string } = {
      id: row.id,
      label: row.label,
      token_hash: row.token_hash,
      revoked: row.revoked,
      created_at: row.created_at,
      expires_at: row.expires_at,
    };
    clientMap.set(row.id, client);
  }
  for (const row of grants) {
    const list = grantMap.get(row.client_id) ?? [];
    list.push({
      client_id: row.client_id,
      connection_id: row.connection_id,
      capabilities: asStringArray(row.capabilities),
      ...(row.visibility !== null ? { visibility: asRecord(row.visibility) as NonNullable<Grant['visibility']> } : {}),
    });
    grantMap.set(row.client_id, list);
  }

  // Load and decrypt credentials
  const credRows = await db.listAllCredentials();
  for (const row of credRows) {
    const existing = connectorRegistry.getCredentials(row.connection_id) ?? {};
    try {
      const decrypted = vault.decrypt({
        ciphertext: row.ciphertext,
        iv: row.iv,
        auth_tag: row.auth_tag,
      }, vaultContext.credential(row.connection_id, row.key));
      existing[row.key] = decrypted;
      connectorRegistry.setCredentials(row.connection_id, existing);
    } catch (e) {
      console.error(`[restore] Failed to decrypt credential ${row.connection_id}:${row.key}:`, (e as Error).message);
    }
  }
}

export interface BuildServerOptions {
  /** SQLite file; defaults to the DB_PATH env var. */
  dbPath?: string;
  /** Called for every route as it is registered (tests use it to enumerate routes). */
  onRoute?: (route: RouteOptions) => void;
  connectorsDir?: string;
  browserClient?: BrowserClient;
  dispatcher?: Dispatcher;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const db = new DbClient(options.dbPath ?? DB_PATH);
  let leaseApp: import('fastify').FastifyInstance | undefined;
  const dbLease = await acquireDbLease(db, { mode: 'server' }).catch(async (error: unknown) => { await db.close(); throw error; });
  dbLease.start(async () => { await leaseApp?.close(); });
  try {
  const vault = new Vault(MASTER_KEY);
  await migrateEncryptedRecords(db, vault, { heartbeat: () => dbLease.renew() });
  const secrets = new SecretRedactor();
  let mcpController: McpController | undefined;
  const notifyChanged = async (clientId?: string) => { await mcpController?.notifyChanged(clientId); };

  // ── Connector registry — loads YAML manifests from connectors/ dir ────────
  const connectorRegistry = new ConnectorRegistry();
  const connectorsDir = options.connectorsDir ?? process.env['CONNECTORS_DIR'] ?? fileURLToPath(new URL('../../../connectors', import.meta.url));
  connectorRegistry.loadDirectory(connectorsDir);
  const extensionService = new ExtensionService({ db, registry: connectorRegistry,
    invalidate: async () => { await cacheStore.invalidate(''); await notifyChanged(); },
    audit: (entry) => auditStore.append({ client_id: undefined, target: entry.target, action: entry.action, detail: entry.detail }),
  });
  await extensionService.init();

  // ── In-memory stores (M1 — backed by DB worker for persistence) ──────────
  const connectionMap = new Map<string, Connection>();
  const clientMap = new Map<string, Client>();
  const grantMap = new Map<string, Grant[]>();
  await restoreState(db, connectionMap, clientMap, grantMap, vault, connectorRegistry);
  for (const conn of connectionMap.values()) {
    const credentials = connectorRegistry.getCredentials(conn.id) ?? {};
    const fields = connectorRegistry.getManifest(conn.connector_id)?.compiled.auth?.fields ?? {};
    secrets.register(conn.id, Object.entries(credentials)
      .filter(([key]) => (fields[key] as { secret?: boolean } | undefined)?.secret !== false)
      .map(([, value]) => value));
  }

  // ── Service implementations ───────────────────────────────────────────────

  const capRegistry: CapabilityRegistry = {
    get: (connectorId, capabilityId) => connectorRegistry.getCapability(connectorId, capabilityId),
    version: (connectorId) => connectorRegistry.getManifest(connectorId)?.compiled.version ?? '',
    list: (connectorId) => connectorRegistry.listCapabilities(connectorId),
  };

  const connStore: ConnectionStore = {
    get: (id) => connectionMap.get(id),
  };

  const authStore: AuthStore = {
    getClientById: (id) => clientMap.get(id),
    getClient: (tokenHash) => {
      for (const client of clientMap.values()) {
        if ((client as unknown as Record<string, string>)['token_hash'] === tokenHash) {
          return client; // return revoked clients too — invoke() checks revoked flag
        }
      }
      return undefined;
    },
    getGrants: (clientId) => grantMap.get(clientId) ?? [],
  };

  const cacheStore: CacheStore = {
    get: async (key) => {
      const hash = createHash('sha256').update(key).digest('hex');
      const row = await db.getCacheEntry(hash);
      if (!row) return undefined;
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await db.deleteCacheEntry(hash);
        return undefined;
      }
      try { return vault.decryptJSON<CachedResult>(row, vaultContext.cache(hash)); }
      catch { await db.deleteCacheEntry(hash); return undefined; }
    },
    set: async (key, envelope, ttl) => {
      const now = Date.now();
      const cached: CachedResult = {
        envelope,
        cached_at: new Date(now).toISOString(),
        expires_at: new Date(now + Math.min(ttl, 7 * 86400) * 1000).toISOString(),
        ttl,
      };
      const hash = createHash('sha256').update(key).digest('hex');
      await db.setCacheEntry({ key: hash,
        ...vault.encryptJSON(cached, vaultContext.cache(hash)), cached_at: cached.cached_at, expires_at: cached.expires_at });
    },
    invalidate: async () => {
      await db.clearCache();
    },
  };

  const auditStore: AuditStore = {
    append: async (entry) => {
      await db.appendAuditLog({
        action: entry.action,
        client_id: entry.client_id,
        target: entry.target,
        detail: secrets.redact(entry.detail),
      });
    },
  };

  // ── Browser client (§13.1 RPC) ────────────────────────────────────────────
  const browserRpcUrl = (process.env['BROWSER_RPC_URL'] ?? 'http://browser:4000').replace(/\/$/, '');
  const browserRpcSecret = readSecret('BROWSER_RPC_SECRET') ?? '';
  const browserClient: BrowserClient = options.browserClient ?? createBrowserClient({
    baseUrl: browserRpcUrl,
    secret: browserRpcSecret,
  });

  // ── Unified dispatcher (now takes BrowserClient) ──────────────────────────
  const writeState = createStateWriter(connectionMap, db);
  const stateWriter: StateWriterFn = async (id, code, opts) => {
    const revision = connectionMap.get(id)?.updated_at;
    await writeState(id, code, opts);
    if (revision !== connectionMap.get(id)?.updated_at) await notifyChanged();
  };
  const httpRuntime = new IsolatedHttpRuntime({ registry: connectorRegistry, getConnection: (id) => connectionMap.get(id), sanitize: (data) => secrets.redact(data),
    ...(process.env['HTTP_RUNTIME_URL'] || process.env['NODE_ENV'] === 'production' ? { runtimeUrl: process.env['HTTP_RUNTIME_URL'] ?? 'http://http-runtime:5000' } : {}),
    ...(readSecret('HTTP_RUNTIME_SECRET') ? { secret: readSecret('HTTP_RUNTIME_SECRET')! } : {}),
    ...(process.env['HTTP_BROKER_ORIGIN'] || process.env['NODE_ENV'] === 'production' ? { brokerOrigin: process.env['HTTP_BROKER_ORIGIN'] ?? 'http://server:3000' } : {}),
  });
  const unifiedDispatcher = new UnifiedDispatcher(connectorRegistry, browserClient, httpRuntime);
  const executionLimits = new ExecutionLimits();
  const dispatcher = {
    dispatch: async (connection: Connection, capability: Capability, input: unknown) => {
      const execute = () => (options.dispatcher ?? unifiedDispatcher).dispatch(connection, capability, input);
      const result = capability.transport === 'http'
        ? await executionLimits.run(connection, capability, connectorRegistry.getManifest(connection.connector_id)?.http?.rate_limit?.rpm ?? 30, execute)
        : await execute();
      // Account risk is an immediate pause. Ordinary capability observations
      // are recorded only after invoke() has completed all result guards.
      if (result.error?.code === 'RISK_CONTROL_DETECTED' || (result.error?.details as { connection_status?: string } | undefined)?.connection_status === 'paused') {
        await stateWriter(connection.id, result.error?.code, { paused: true });
      }
      return result;
    },
  };

  const services: InvokeServices = {
    capabilities: capRegistry,
    connections: connStore,
    auth: authStore,
    cache: cacheStore,
    audit: auditStore,
    dispatch: dispatcher,
  };

  const invokeOpts: InvokeOptions = {
    hashToken: (token) => createHash('sha256').update(token).digest('hex'),
    redactOutput: (data, capability, audience, _client, grant) => {
      const visibility = grant?.visibility;
      const { data: redacted } = redact(data, capability.output, {
        includePii: audience === 'admin' || visibility?.pii === true,
        ...(visibility?.financial !== undefined ? { includeFinancial: visibility.financial } : {}),
        ...(visibility?.content !== undefined ? { includeContent: visibility.content } : {}),
      });
      return redacted;
    },
    sanitize: (value) => secrets.redact(value),
    onInvocationResult: (result, context) => verifier.observe(result, context),
  };

  // ── Fastify server ─────────────────────────────────────────────────────────
  const app = Fastify({ logger: { level: process.env['VITEST'] ? 'error' : LOG_LEVEL } });
  leaseApp = app;
  if (options.onRoute !== undefined) app.addHook('onRoute', options.onRoute);

  const taskService = new TaskService({ db, vault, services, invokeOpts, getClientById: (id) => clientMap.get(id), isAdminActive: async (id) => !!await db.getAdminById(id) });
  const actionService = new ActionService({ db, vault, services, invokeOpts });
  await actionService.init();
  const monitorService = new MonitorService({ db, vault,
    getConnection: (id) => connectionMap.get(id),
    getCapability: (id, capId) => { const c = connectionMap.get(id); return c ? connectorRegistry.getCapability(c.connector_id, capId, c) : undefined; },
    invoke: (req, monitorId) => invoke(req, services, { ...invokeOpts, redactOutput: (data, cap) => invokeOpts.redactOutput(data, cap, 'client') }, { kind: 'admin', user_id: `monitor:${monitorId}` }),
    audit: (entry) => auditStore.append({ client_id: undefined, action: entry.action, target: entry.target, detail: entry.detail }),
  });
  await monitorService.init();

  // ── Probe scheduler (§4.4.3, §4.5) ────────────────────────────────────────
  // Resolves probe targets only for browser-transport connections with login.
  const probeScheduler = new ProbeScheduler({
    db,
    connectionMap,
    probe: async (connectionId) => {
      const conn = connectionMap.get(connectionId);
      if (!conn) return { status: 'not_found', reason: 'connection not found' };
      const login = connectorRegistry.getLogin(conn.connector_id);
      if (!login) return { status: 'skipped', reason: 'no login block' };
      const result = await browserClient.probe({
        connection_id: connectionId,
        connector_id: conn.connector_id,
        egress_policy: egressPolicy(conn, connectorRegistry),
        login_url: login.url,
        success_when: login.successWhen,
        ...(login.whoami !== undefined ? { whoami: login.whoami } : {}),
      });
      if (result.connection_status === 'paused') await stateWriter(connectionId, result.error_code === 'RISK_CONTROL_DETECTED' ? 'RISK_CONTROL_DETECTED' : 'RATE_LIMITED', { paused: true });
      return result;
    },
    resolveTarget: (connection): ProbeTarget | undefined => {
      const login = connectorRegistry.getLogin(connection.connector_id);
      if (!login || !login.whoami) return undefined;
      const caps = connectorRegistry.listCapabilities(connection.connector_id, connection);
      return { whoami: login.whoami, capabilities: caps.filter((c) => c.kind === 'query' && !['disabled', 'unsupported'].includes(c.support.status)).map((c) => c.id) };
    },
    audit: (entry) => auditStore.append({
      client_id: undefined,
      action: entry.action,
      target: entry.target,
      detail: entry.detail,
    }),
    nextSequence: () => reserveInvocationSequence(services),
    onObserved: (id, capabilityId, sequence, updatedIds) => verifier.noteProbe(id, capabilityId, sequence, updatedIds),
    intervalMs: PROBE_INTERVAL_MS,
  });

  // Start probe scheduler only in production; tests control it explicitly.
  app.addHook('onReady', async () => {
    if (!process.env['VITEST']) { probeScheduler.start(); taskService.start(); monitorService.start(); }
  });

  app.addHook('onClose', async () => {
    probeScheduler.stop();
    await Promise.all([taskService.stop(), monitorService.stop()]);
    try { await dbLease.release(); } finally { await db.close(); }
  });

  // Health check
  app.get('/health', async () => ({ ok: true, time: new Date().toISOString() }));

  // ── Admin authentication (design §7.2, §8.2, D8) ──────────────────────────
  // Must be registered before any module that reads request.cookies:
  // registerAuthRoutes installs @fastify/cookie (fastify-plugin, so it leaks
  // out to routes registered afterwards).
  const authService = createAuthService({
    db,
    vault,
    rpID: process.env['OWNGATE_RP_ID'] ?? 'localhost',
    rpName: 'OwnGate',
    origin: process.env['OWNGATE_ORIGIN'] ?? 'http://localhost:3000',
  });
  await registerAuthRoutes(app, { auth: authService, db });

  // §8.4: every /admin/* route needs an admin session, and the sensitive ones
  // a recent step-up. One root-level hook (after the cookie parser) covers
  // every route module, including ones added later.
  app.addHook('onRequest', createAdminGate(authService));
  await httpRuntime.init(app);

  // Register route modules
  await registerRestRoutes(app, { services, invokeOpts, tasks: taskService });
  mcpController = await registerMcpRoutes(app, { db, services, invokeOpts, tasks: taskService, actions: actionService, listConnectionIds: () => [...connectionMap.keys()] });
  const getAdminUserId = async (request: import('fastify').FastifyRequest) => {
    const sid = request.cookies[SESSION_COOKIE]; return sid ? (await authService.getSession(sid))?.userId ?? null : null;
  };
  await registerTaskRoutes(app, { tasks: taskService, services, invokeOpts, getAdminUserId });
  await registerMonitorRoutes(app, { service: monitorService });
  await registerExtensionRoutes(app, { service: extensionService });
  const getCapability = (id: string, capId: string) => { const connection = connectionMap.get(id); return connection ? connectorRegistry.getCapability(connection.connector_id, capId, connection) : undefined; };
  const verifier = new ConnectionVerifier({ db, getConnection: id => connectionMap.get(id), getCapability,
    listCapabilities: id => { const connection = connectionMap.get(id); return connection ? connectorRegistry.listCapabilities(connection.connector_id, connection) : []; },
    getPlan: id => {
      const connection = connectionMap.get(id), manifest = connection && connectorRegistry.getManifest(connection.connector_id)?.compiled;
      return { ...(manifest?.verification ? { verification: manifest.verification } : {}), ...(manifest?.login?.whoami ? { whoami: manifest.login.whoami } : {}), browser: manifest?.transport === 'browser' };
    },
    invoke: (request, userId, verify = false) => invokeAdminWithTrace(request, services, invokeOpts, { kind: 'admin', user_id: userId, ...(verify ? { verify: true as const } : {}) }),
    notifyChanged,
  });
  const comparisonService = new ComparisonService({ db, getConnection: id => connectionMap.get(id), getCapability,
    getView: (id, viewId) => { const connection = connectionMap.get(id); return connection ? connectorRegistry.getManifest(connection.connector_id)?.compiled.views?.find(view => view.id === viewId) : undefined; },
    invoke: (request, userId) => verifier.run(request.connection_id, request.capability_id, request.input ?? {}, userId),
    audit: (entry) => auditStore.append({ client_id: undefined, action: entry.action, target: entry.target, detail: entry.detail }),
  });
  await registerComparisonRoutes(app, { service: comparisonService, getAdminUserId });
  await registerActionRoutes(app, { actions: actionService, services, invokeOpts, getAdminUserId,
    approvalMethod: async (req) => {
      const sid = req.cookies[SESSION_COOKIE], uid = await getAdminUserId(req);
      if (!sid || !uid) return null;
      const method = await authService.stepUpMethod(sid);
      return method === 'totp' && (await authService.listPasskeys(uid)).length > 0 ? null : method;
    },
  });
  await registerProductRoutes(app, { db, services, invokeOpts, connections: connectionMap, connectorRegistry, browser: browserClient, getAdminUserId, invalidate: () => cacheStore.invalidate('') as Promise<void>, cancelConnection: (id) => taskService.cancelConnection(id), resetLimits: (id) => executionLimits.reset(id), notifyChanged });
  await registerClientApiRoutes(app, {
    auth: authStore,
    connections: connStore,
    hashToken: invokeOpts.hashToken,
    listCapabilities: (connectorId) => connectorRegistry.listCapabilities(connectorId),
  });
  await registerAdminRoutes(app, {
    db,
    vault,
    connectionMap,
    clientMap,
    grantMap,
    connectorRegistry,
    browserClient,
    cancelConnection: (id) => taskService.cancelConnection(id),
    notifyChanged,
    secrets,
    invalidateCache: () => cacheStore.invalidate(''),
    getAdminUserId: async (request) => {
      const sessionId = request.cookies[SESSION_COOKIE];
      return sessionId ? (await authService.getSession(sessionId))?.userId ?? null : null;
    },
    verifier,
    invoke: (request, userId, verify = false) => invokeAdminWithTrace(request, services, invokeOpts,
      { kind: 'admin', user_id: userId, ...(verify ? { verify: true as const } : {}) }),
    audit: (entry) => auditStore.append({
      client_id: entry.client_id,
      action: entry.action,
      target: entry.target,
      detail: entry.detail,
    }),
  });

  // Remote screen forwarding (design §4.4.5: screen only through the server).
  // Gates are the real admin session + step-up, not stand-ins.
  await registerScreenRoutes(app, {
    getAdminUserId: async (request) => {
      const sessionId = request.cookies[SESSION_COOKIE];
      if (sessionId === undefined) return null;
      const session = await authService.getSession(sessionId);
      return session?.userId ?? null;
    },
    hasStepUp: async (request) => {
      const sessionId = request.cookies[SESSION_COOKIE];
      if (sessionId === undefined) return false;
      return authService.hasStepUp(sessionId);
    },
    browserClient: {
      startLogin: (req) => {
        const { success_when, ...rest } = req;
        const connection = connectionMap.get(req.connection_id);
        return browserClient.startLogin({
          ...rest,
          success_when: success_when as unknown as import('./browser-client.js').LoginCondition[],
          ...(connection ? { egress_policy: egressPolicy(connection, connectorRegistry) } : {}),
        });
      },
      stopLogin: (connectionId) => browserClient.stopLogin(connectionId),
      loginStatus: (connectionId) => browserClient.loginStatus(connectionId),
      openScreencast: (streamToken) => browserClient.openScreencast(streamToken),
    },
    onLoginCompleted: (id, since) => verifier.loginCompleted(id, since),
    connectionMap,
    getLogin: (connectorId) => connectorRegistry.getLogin(connectorId),
    audit: (entry) => auditStore.append({
      client_id: entry.client_id,
      action: entry.action,
      target: entry.target,
      detail: entry.detail,
    }),
  });

  // Probe routes (design §4.4.3).
  await registerProbeRoutes(app, {
    scheduler: probeScheduler,
    requireAdmin: async (request) => {
      const sessionId = request.cookies[SESSION_COOKIE];
      if (sessionId === undefined) return false;
      const session = await authService.getSession(sessionId);
      return session !== null;
    },
  });

  // Admin web UI (built by apps/web). Served from the server so nginx only
  // needs a single upstream.
  const webRoot = process.env['WEB_ROOT'] ?? '';
  if (webRoot !== '' && existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
    // SPA fallback: unknown non-API paths return index.html
    app.setNotFoundHandler(async (request, reply) => {
      const url = request.raw.url ?? '/';
      if (url.startsWith('/api') || url.startsWith('/admin') || url.startsWith('/mcp') || url.startsWith('/auth') || url.startsWith('/ws') || url.startsWith('/health') || url.startsWith('/internal')) {
        return reply.status(404).send({ error: 'Not Found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return { app, db, vault, services, invokeOpts, connectorRegistry, taskService, monitorService, actionService, comparisonService, verifier, extensionService, mcpController };
  } catch (error) {
    // Registration failures may happen after the private broker has started.
    // Drain route-owned sessions/listeners before releasing the DB owner.
    await leaseApp?.close().catch(() => undefined);
    try { await dbLease.release(); } finally { await db.close(); }
    throw error;
  }
}

// ── Start only when this module is the entry point ─────────────────────────
// Tests import buildServer(); importing must not bind a port.

const entryArg = process.argv[1];
const isMain =
  entryArg !== undefined && import.meta.url === pathToFileURL(resolve(entryArg)).href;

if (isMain) {
  const { app } = await buildServer();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Release the DB lease before Docker restarts this process. A forced kill
    // still relies on lease expiry and cannot revive the previous owner.
    void app.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try { await app.listen({ port: PORT, host: '0.0.0.0' }); }
  catch (error) { await app.close(); throw error; }
  console.log(`owngate-server listening on port ${PORT}`);
}
