// apps/server entry point — minimal M0 skeleton that wires all packages together
// and exposes three entry points: REST, MCP (Streamable HTTP), and admin backend.

import Fastify from 'fastify';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DbClient } from '@webridge/db';
import { Vault } from '@webridge/vault';
import { redact } from '@webridge/vault';
import type {
  InvokeServices, InvokeOptions,
  CapabilityRegistry, ConnectionStore, AuthStore,
  CacheStore, AuditStore, Dispatcher, CachedResult,
} from '@webridge/core';
import {
  invoke,
  err,
  fail,
} from '@webridge/core';
import type { Capability, Connection, Client, Grant, ResultEnvelope } from '@webridge/core';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerRestRoutes } from './routes/rest.js';
import { registerAdminRoutes } from './routes/admin.js';

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

  // ── In-memory caches (M0 — will replace with DB-backed encrypted cache in M1) ──
  const memCache = new Map<string, CachedResult>();
  const auditBuffer: unknown[] = [];

  // ── Service implementations ───────────────────────────────────────────────
  // These are thin adapters over the DB worker. In production, capability
  // registry and connection store will be populated from the DB on startup
  // and invalidated on config changes.

  const capabilityMap = new Map<string, Capability>();
  const connectionMap = new Map<string, Connection>();
  const clientMap = new Map<string, Client>();
  const grantMap = new Map<string, Grant[]>();

  const capRegistry: CapabilityRegistry = {
    get: (connectorId, capabilityId) => capabilityMap.get(`${connectorId}:${capabilityId}`),
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
      auditBuffer.push({ ...entry, at: new Date().toISOString() });
      // Flush to DB asynchronously (fire-and-forget for M0)
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

  const dispatcher: Dispatcher = {
    dispatch: async (connection, capability, input) => {
      // M0 stub dispatcher — returns a fixed response for the test connector
      // Real dispatchers (HTTP, browser) are implemented in M3/M1 respectively.
      const source = {
        connection_id: connection.id,
        connection_label: connection.label,
        capability_id: capability.id,
        support: connection.capability_states[capability.id] ?? capability.support,
      };

      if (connection.connector_id === 'test-connector') {
        return {
          outcome: 'success' as const,
          data: { message: 'pong', connection: connection.label, capability: capability.id },
          error: null,
          fields: {},
          source,
          data_time: new Date().toISOString(),
          queried_at: new Date().toISOString(),
          cache: null,
          warnings: [],
        };
      }

      return fail(
        err('NOT_SUPPORTED', `No dispatcher for connector: ${connection.connector_id}`),
        source,
      );
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
  await registerAdminRoutes(app, { db, vault, connectionMap, clientMap, grantMap, capabilityMap });

  return { app, db, vault, services, invokeOpts };
}

// ── Start ──────────────────────────────────────────────────────────────────

const { app } = await buildServer();
await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`webridge-server listening on port ${PORT}`);
