// DB worker — runs in a dedicated worker_thread, owns the SQLite connection.
// Main thread sends messages via the DbClient class and waits for responses.
// Design doc D2: one slow query must not block MCP connections or CDP streaming.

import { workerData, parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, desc } from 'drizzle-orm';
import * as schema from './schema.js';
import type { DbRequest, DbResponse } from './types.js';

if (!parentPort) throw new Error('Must run as worker_thread');

const __dirname = dirname(fileURLToPath(import.meta.url));

const db = new Database(workerData.dbPath as string, { verbose: undefined });

// Run migrations on startup
const migrateSql = readFileSync(resolve(__dirname, 'migrate.sql'), 'utf8');
db.exec(migrateSql);

const orm = drizzle(db, { schema });

parentPort.on('message', async (req: DbRequest) => {
  const { id, method, args } = req;
  try {
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown DB method: ${method}`);
    const result = await handler(args);
    const resp: DbResponse = { id, ok: true, result };
    parentPort!.postMessage(resp);
  } catch (err) {
    const resp: DbResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    parentPort!.postMessage(resp);
  }
});

// ── Method handlers ────────────────────────────────────────────────────────
// Each handler runs synchronously (better-sqlite3 is sync) but is wrapped
// in async so we can extend to async ops if needed later.

type Handler = (args: unknown) => Promise<unknown>;
const handlers: Record<string, Handler> = {

  // Connectors
  async upsertConnector(args) {
    const { id, version, title, transport, manifest } = args as typeof schema.connectors.$inferInsert;
    return orm.insert(schema.connectors)
      .values({ id, version, title, transport, manifest })
      .onConflictDoUpdate({ target: schema.connectors.id, set: { version, title, manifest } })
      .returning()
      .get();
  },

  async listConnectors() {
    return orm.select().from(schema.connectors).all();
  },

  // Connections
  async createConnection(args) {
    const val = args as typeof schema.connections.$inferInsert;
    return orm.insert(schema.connections).values(val).returning().get();
  },

  async getConnection(args) {
    const { id } = args as { id: string };
    return orm.query.connections.findFirst({ where: (c, { eq }) => eq(c.id, id) });
  },

  async listConnections() {
    return orm.select().from(schema.connections).all();
  },

  async updateConnectionStates(args) {
    const { id, capability_states, updated_at } = args as {
      id: string; capability_states: unknown; updated_at: string;
    };
    return orm.update(schema.connections)
      .set({ capability_states, updated_at })
      .where(eq(schema.connections.id, id))
      .returning()
      .get();
  },

  // Clients
  async createClient(args) {
    const val = args as typeof schema.clients.$inferInsert;
    return orm.insert(schema.clients).values(val).returning().get();
  },

  async getClientByToken(args) {
    const { token_hash } = args as { token_hash: string };
    return orm.query.clients.findFirst({
      where: (c, { eq, and }) => and(eq(c.token_hash, token_hash), eq(c.revoked, false)),
    });
  },

  async revokeClient(args) {
    const { id } = args as { id: string };
    return orm.update(schema.clients)
      .set({ revoked: true })
      .where(eq(schema.clients.id, id))
      .returning()
      .get();
  },

  // Tasks
  async createTask(args) {
    const val = args as typeof schema.tasks.$inferInsert;
    return orm.insert(schema.tasks).values(val).returning().get();
  },

  async updateTaskStatus(args) {
    const { id, status, started_at, finished_at } = args as {
      id: string; status: string; started_at?: string; finished_at?: string;
    };
    return orm.update(schema.tasks)
      .set({ status, started_at, finished_at })
      .where(eq(schema.tasks.id, id))
      .returning()
      .get();
  },

  async getTask(args) {
    const { id } = args as { id: string };
    return orm.query.tasks.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  },

  // Cache
  async getCacheEntry(args) {
    const { key } = args as { key: string };
    return orm.query.results_cache.findFirst({ where: (c, { eq }) => eq(c.key, key) });
  },

  async setCacheEntry(args) {
    const val = args as typeof schema.results_cache.$inferInsert;
    return orm.insert(schema.results_cache)
      .values(val)
      .onConflictDoUpdate({ target: schema.results_cache.key, set: val })
      .returning()
      .get();
  },

  async deleteCacheEntry(args) {
    const { key } = args as { key: string };
    return orm.delete(schema.results_cache)
      .where(eq(schema.results_cache.key, key))
      .returning()
      .get();
  },

  // Audit log
  async appendAuditLog(args) {
    const val = args as typeof schema.audit_log.$inferInsert;
    return orm.insert(schema.audit_log).values(val).returning().get();
  },

  async getLastAuditEntry() {
    return orm.select().from(schema.audit_log)
      .orderBy(desc(schema.audit_log.seq))
      .limit(1)
      .get();
  },

  // Grants
  async upsertGrant(args) {
    const val = args as typeof schema.grants.$inferInsert;
    return orm.insert(schema.grants).values(val).returning().get();
  },

  async getGrants(args) {
    const { client_id } = args as { client_id: string };
    return orm.query.grants.findMany({
      where: (g, { eq }) => eq(g.client_id, client_id),
    });
  },

  // Raw query escape hatch for migrations / admin
  async rawQuery(args) {
    const { sql, params } = args as { sql: string; params?: unknown[] };
    return db.prepare(sql).all(...(params ?? []) as Parameters<typeof db.prepare>[0][]);
  },
};
