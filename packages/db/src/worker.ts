// DB worker — runs in a dedicated worker_thread, owns the SQLite connection.
// Main thread sends messages via the DbClient class and waits for responses.
// Design doc D2: one slow query must not block MCP connections or CDP streaming.

import { workerData, parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq, desc, count, lt } from 'drizzle-orm';
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

  async deleteConnection(args) {
    // grants and credentials cascade via their foreign keys.
    const { id } = args as { id: string };
    return orm.delete(schema.connections)
      .where(eq(schema.connections.id, id))
      .returning()
      .get();
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

  async listClients() {
    // Includes revoked clients: callers need the flag to answer CLIENT_REVOKED.
    return orm.select().from(schema.clients).all();
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
    // (client_id, connection_id) is the primary key: a second grant for the
    // same pair replaces the capability list instead of failing.
    const val = args as typeof schema.grants.$inferInsert;
    return orm.insert(schema.grants)
      .values(val)
      .onConflictDoUpdate({
        target: [schema.grants.client_id, schema.grants.connection_id],
        set: { capabilities: val.capabilities },
      })
      .returning()
      .get();
  },

  async getGrants(args) {
    const { client_id } = args as { client_id: string };
    return orm.query.grants.findMany({
      where: (g, { eq }) => eq(g.client_id, client_id),
    });
  },

  async listGrants() {
    return orm.select().from(schema.grants).all();
  },

  // Admin users (auth)
  async getAdminByUsername(args) {
    const { username } = args as { username: string };
    return orm.query.admin_users.findFirst({ where: (u, { eq }) => eq(u.username, username) });
  },

  async getAdminById(args) {
    const { id } = args as { id: string };
    return orm.query.admin_users.findFirst({ where: (u, { eq }) => eq(u.id, id) });
  },

  async countAdminUsers() {
    const row = orm.select({ n: count() }).from(schema.admin_users).get();
    return row?.n ?? 0;
  },

  async createAdminUser(args) {
    const val = args as typeof schema.admin_users.$inferInsert;
    return orm.insert(schema.admin_users).values(val).returning().get();
  },

  async updateAdminPassword(args) {
    const { id, password_hash } = args as { id: string; password_hash: string };
    return orm.update(schema.admin_users)
      .set({ password_hash })
      .where(eq(schema.admin_users.id, id))
      .returning()
      .get();
  },

  async setTotpEnabled(args) {
    const { id, totp_enabled } = args as { id: string; totp_enabled: boolean };
    return orm.update(schema.admin_users)
      .set({ totp_enabled })
      .where(eq(schema.admin_users.id, id))
      .returning()
      .get();
  },

  // TOTP secrets (encrypted via Vault)
  async getTotpSecret(args) {
    const { user_id } = args as { user_id: string };
    return orm.query.totp_secrets.findFirst({ where: (t, { eq }) => eq(t.user_id, user_id) });
  },

  async upsertTotpSecret(args) {
    const val = args as typeof schema.totp_secrets.$inferInsert;
    return orm.insert(schema.totp_secrets)
      .values(val)
      .onConflictDoUpdate({
        target: schema.totp_secrets.user_id,
        set: {
          ciphertext: val.ciphertext,
          iv: val.iv,
          auth_tag: val.auth_tag,
          updated_at: new Date().toISOString(),
        },
      })
      .returning()
      .get();
  },

  async deleteTotpSecret(args) {
    const { user_id } = args as { user_id: string };
    return orm.delete(schema.totp_secrets)
      .where(eq(schema.totp_secrets.user_id, user_id))
      .returning()
      .get();
  },

  // WebAuthn credentials
  async listWebauthnCredentials(args) {
    const { user_id } = args as { user_id: string };
    return orm.select().from(schema.webauthn_credentials)
      .where(eq(schema.webauthn_credentials.user_id, user_id))
      .all();
  },

  async getWebauthnCredentialByCredentialId(args) {
    const { credential_id } = args as { credential_id: string };
    return orm.query.webauthn_credentials.findFirst({
      where: (c, { eq }) => eq(c.credential_id, credential_id),
    });
  },

  async insertWebauthnCredential(args) {
    const val = args as typeof schema.webauthn_credentials.$inferInsert;
    return orm.insert(schema.webauthn_credentials).values(val).returning().get();
  },

  async updateWebauthnCounter(args) {
    const { credential_id, counter } = args as { credential_id: string; counter: number };
    return orm.update(schema.webauthn_credentials)
      .set({ counter })
      .where(eq(schema.webauthn_credentials.credential_id, credential_id))
      .returning()
      .get();
  },

  async deleteWebauthnCredential(args) {
    const { id, user_id } = args as { id: string; user_id: string };
    return orm.delete(schema.webauthn_credentials)
      .where(and(
        eq(schema.webauthn_credentials.id, id),
        eq(schema.webauthn_credentials.user_id, user_id),
      ))
      .returning()
      .get();
  },

  // Login sessions
  async insertLoginSession(args) {
    const val = args as typeof schema.login_sessions.$inferInsert;
    return orm.insert(schema.login_sessions).values(val).returning().get();
  },

  async getLoginSession(args) {
    const { id } = args as { id: string };
    return orm.query.login_sessions.findFirst({ where: (s, { eq }) => eq(s.id, id) });
  },

  async deleteLoginSession(args) {
    const { id } = args as { id: string };
    return orm.delete(schema.login_sessions)
      .where(eq(schema.login_sessions.id, id))
      .returning()
      .get();
  },

  async deleteLoginSessionsForUser(args) {
    const { user_id } = args as { user_id: string };
    return orm.delete(schema.login_sessions)
      .where(eq(schema.login_sessions.user_id, user_id))
      .returning()
      .all();
  },

  async deleteExpiredLoginSessions(args) {
    // expires_at is always written by the auth service in ISO-8601 (UTC) form,
    // so a lexicographic comparison against another ISO string is chronological.
    const { now } = args as { now: string };
    return orm.delete(schema.login_sessions)
      .where(lt(schema.login_sessions.expires_at, now))
      .returning()
      .all();
  },

  // Raw query escape hatch for migrations / admin
  async rawQuery(args) {
    const { sql, params } = args as { sql: string; params?: unknown[] };
    return db.prepare(sql).all(...(params ?? []) as Parameters<typeof db.prepare>[0][]);
  },
};
