// apps/server entry point — wires all packages together and exposes three
// entry points: REST, MCP (Streamable HTTP), and the admin backend.

import Fastify from 'fastify';
import type { RouteOptions } from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DbClient } from '@webridge/db';
import { Vault } from '@webridge/vault';
import { redact } from '@webridge/vault';
import type {
  InvokeServices, InvokeOptions,
  CapabilityRegistry, ConnectionStore, AuthStore,
  CacheStore, AuditStore, CachedResult,
} from '@webridge/core';
import { invoke } from '@webridge/core';
import type { Capability, Connection, Client, ClientKind, Grant, SupportState } from '@webridge/core';
import { registerMcpRoutes } from './routes/mcp.js';
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

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const DB_PATH = process.env['DB_PATH'] ?? './webridge.db';
const LOG_LEVEL = process.env['LOG_LEVEL'] ?? 'info';
const PROBE_INTERVAL_MS = parseInt(process.env['WEBRIDGE_PROBE_INTERVAL_MS'] ?? '', 10) || DEFAULT_PROBE_INTERVAL_MS;

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
    connectionMap.set(row.id, {
      id: row.id,
      connector_id: row.connector_id,
      label: row.label,
      config: asRecord(row.config),
      capability_states: asRecord(row.capability_states) as Record<string, SupportState>,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }
  for (const row of clients) {
    const client: Client & { token_hash: string } = {
      id: row.id,
      label: row.label,
      kind: row.kind as ClientKind,
      token_hash: row.token_hash,
      revoked: row.revoked,
      created_at: row.created_at,
    };
    clientMap.set(row.id, client);
  }
  for (const row of grants) {
    const list = grantMap.get(row.client_id) ?? [];
    list.push({
      client_id: row.client_id,
      connection_id: row.connection_id,
      capabilities: asStringArray(row.capabilities),
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
      });
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
}

export async function buildServer(options: BuildServerOptions = {}) {
  const db = new DbClient(options.dbPath ?? DB_PATH);
  const vault = new Vault(MASTER_KEY);

  // ── Connector registry — loads YAML manifests from connectors/ dir ────────
  const connectorRegistry = new ConnectorRegistry(vault);
  const connectorsDir = process.env['CONNECTORS_DIR'] ?? resolve(process.cwd(), 'connectors');
  connectorRegistry.loadDirectory(connectorsDir);

  // ── In-memory stores (M1 — backed by DB worker for persistence) ──────────
  const memCache = new Map<string, CachedResult>();

  const connectionMap = new Map<string, Connection>();
  const clientMap = new Map<string, Client>();
  const grantMap = new Map<string, Grant[]>();
  await restoreState(db, connectionMap, clientMap, grantMap, vault, connectorRegistry);

  // ── Service implementations ───────────────────────────────────────────────

  const capRegistry: CapabilityRegistry = {
    get: (connectorId, capabilityId) => connectorRegistry.getCapability(connectorId, capabilityId),
  };

  const connStore: ConnectionStore = {
    get: (id) => connectionMap.get(id),
  };

  const authStore: AuthStore = {
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
    get: (key) => memCache.get(key),
    set: (key, envelope, ttl) => {
      const now = Date.now();
      memCache.set(key, {
        envelope,
        cached_at: new Date(now).toISOString(),
        expires_at: new Date(now + ttl * 1000).toISOString(),
        ttl,
      });
    },
    invalidate: (clientId) => {
      // On revocation, purge all cache entries (conservative)
      memCache.clear();
    },
  };

  const auditStore: AuditStore = {
    append: (entry) => {
      // Flush to DB asynchronously (fire-and-forget)
      db.appendAuditLog({
        action: entry.action,
        client_id: entry.client_id,
        target: entry.target,
        detail: entry.detail,
        prev_hash: '0',
        entry_hash: createHash('sha256')
          .update(JSON.stringify(entry))
          .digest('hex'),
      }).catch((e: Error) => console.error('[audit] write failed:', e.message));
    },
  };

  // ── Browser client (§13.1 RPC) ────────────────────────────────────────────
  const browserRpcUrl = (process.env['BROWSER_RPC_URL'] ?? 'http://browser:4000').replace(/\/$/, '');
  const browserRpcSecret = readSecret('BROWSER_RPC_SECRET') ?? '';
  const browserClient: BrowserClient = createBrowserClient({
    baseUrl: browserRpcUrl,
    secret: browserRpcSecret,
  });

  // ── Unified dispatcher (now takes BrowserClient) ──────────────────────────
  const stateWriter = createStateWriter(connectionMap, db, (connectorId) =>
    connectorRegistry.listCapabilities(connectorId),
  );
  const unifiedDispatcher = new UnifiedDispatcher(connectorRegistry, browserClient);
  const dispatcher = {
    dispatch: (connection: Connection, capability: Capability, input: unknown) =>
      unifiedDispatcher.dispatch(connection, capability, input),
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
    redactOutput: (data, capability) => {
      const { data: redacted } = redact(data, capability.output);
      return redacted;
    },
  };

  // ── Fastify server ─────────────────────────────────────────────────────────
  const app = Fastify({ logger: { level: process.env['VITEST'] ? 'error' : LOG_LEVEL } });
  if (options.onRoute !== undefined) app.addHook('onRoute', options.onRoute);

  // ── Probe scheduler (§4.4.3, §4.5) ────────────────────────────────────────
  // Resolves probe targets only for browser-transport connections with login.
  const probeScheduler = new ProbeScheduler({
    db,
    connectionMap,
    probe: async (connectionId, capabilityId) => {
      const conn = connectionMap.get(connectionId);
      if (!conn) return { status: 'not_found', reason: 'connection not found' };
      const login = connectorRegistry.getLogin(conn.connector_id);
      if (!login) return { status: 'skipped', reason: 'no login block' };
      const result = await browserClient.probe({
        connection_id: connectionId,
        login_url: login.url,
        success_when: login.successWhen,
        ...(login.whoami !== undefined ? { whoami: login.whoami } : {}),
      });
      return result;
    },
    resolveTarget: (connection): ProbeTarget | undefined => {
      const login = connectorRegistry.getLogin(connection.connector_id);
      if (!login || !login.whoami) return undefined;
      const caps = connectorRegistry.listCapabilities(connection.connector_id);
      return { whoami: login.whoami, capabilities: caps.map((c) => c.id) };
    },
    audit: (entry) => auditStore.append({
      client_id: undefined,
      action: entry.action,
      target: entry.target,
      detail: entry.detail,
    }),
    intervalMs: PROBE_INTERVAL_MS,
  });

  // Start probe scheduler only in production; tests control it explicitly.
  app.addHook('onReady', async () => {
    if (!process.env['VITEST']) probeScheduler.start();
  });

  app.addHook('onClose', async () => {
    probeScheduler.stop();
    await db.close();
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
    rpID: process.env['WEBRIDGE_RP_ID'] ?? 'localhost',
    rpName: 'webridge',
    origin: process.env['WEBRIDGE_ORIGIN'] ?? 'http://localhost:3000',
  });
  await registerAuthRoutes(app, { auth: authService, db });

  // §8.4: every /admin/* route needs an admin session, and the sensitive ones
  // a recent step-up. One root-level hook (after the cookie parser) covers
  // every route module, including ones added later.
  app.addHook('onRequest', createAdminGate(authService));

  // Register route modules
  await registerRestRoutes(app, { services, invokeOpts, db, vault });
  await registerMcpRoutes(app, { services, invokeOpts });
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
        return browserClient.startLogin({
          ...rest,
          success_when: success_when as unknown as import('./browser-client.js').LoginCondition[],
        });
      },
      stopLogin: (connectionId) => browserClient.stopLogin(connectionId),
      loginStatus: (connectionId) => browserClient.loginStatus(connectionId),
      openScreencast: (streamToken) => browserClient.openScreencast(streamToken),
    },
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
      if (url.startsWith('/api') || url.startsWith('/admin') || url.startsWith('/mcp') || url.startsWith('/auth') || url.startsWith('/ws') || url.startsWith('/health')) {
        return reply.status(404).send({ error: 'Not Found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return { app, db, vault, services, invokeOpts, connectorRegistry };
}

// ── Start only when this module is the entry point ─────────────────────────
// Tests import buildServer(); importing must not bind a port.

const entryArg = process.argv[1];
const isMain =
  entryArg !== undefined && import.meta.url === pathToFileURL(resolve(entryArg)).href;

if (isMain) {
  const { app } = await buildServer();
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`webridge-server listening on port ${PORT}`);
}
