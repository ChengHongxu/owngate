// apps/server entry point — minimal M0 skeleton that wires all packages together
// and exposes three entry points: REST, MCP (Streamable HTTP), and admin backend.

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DbClient } from '@webridge/db';
import { Vault } from '@webridge/vault';
import { redact } from '@webridge/vault';
import type {
  InvokeServices, InvokeOptions,
  CapabilityRegistry, ConnectionStore, AuthStore,
  CacheStore, AuditStore, CachedResult,
} from '@webridge/core';
import { invoke } from '@webridge/core';
import type { Capability, Connection, Client, Grant } from '@webridge/core';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerRestRoutes } from './routes/rest.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerScreenRoutes } from './routes/screen.js';
import { startLogin, stopLogin } from './dispatchers/browser.js';
import { ConnectorRegistry } from './registry.js';
import { UnifiedDispatcher } from './dispatchers/index.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const DB_PATH = process.env['DB_PATH'] ?? './webridge.db';
const LOG_LEVEL = process.env['LOG_LEVEL'] ?? 'info';

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

export async function buildServer() {
  const db = new DbClient(DB_PATH);
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

  const unifiedDispatcher = new UnifiedDispatcher(connectorRegistry);
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

  // Health check
  app.get('/health', async () => ({ ok: true, time: new Date().toISOString() }));

  // Register route modules
  await registerRestRoutes(app, { services, invokeOpts, db, vault });
  await registerMcpRoutes(app, { services, invokeOpts });
  await registerAdminRoutes(app, {
    db,
    vault,
    connectionMap,
    clientMap,
    grantMap,
    connectorRegistry,
  });

  // Remote screen forwarding (design §4.4.5: screen only through the server).
  // M1 has no admin auth yet, so the gates are permissive stand-ins; the auth
  // module replaces them. Returning a user id here keeps the routes reachable.
  await registerScreenRoutes(app, {
    getAdminUserId: async () => 'admin-local',
    hasStepUp: async () => true,
    startLogin,
    stopLogin,
    audit: (entry) => auditStore.append({ client_id: entry.client_id, action: entry.action, target: entry.target, detail: entry.detail }),
    browserRpcUrl: process.env['BROWSER_RPC_URL'] ?? 'http://browser:4000',
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

// ── Start ──────────────────────────────────────────────────────────────────

const { app } = await buildServer();
await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`webridge-server listening on port ${PORT}`);
