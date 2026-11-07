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
import type { DbRequest, DbResponse, RawStatement } from './types.js';
import { createHash } from 'node:crypto';

if (!parentPort) throw new Error('Must run as worker_thread');

const __dirname = dirname(fileURLToPath(import.meta.url));

const db = new Database(workerData.dbPath as string, { verbose: undefined });

// Run migrations on startup
const migrateSql = readFileSync(resolve(__dirname, 'migrate.sql'), 'utf8');
db.exec(migrateSql);

// SQLite has no ADD COLUMN IF NOT EXISTS. Inspect before each additive upgrade
// so files created by earlier releases remain usable without a destructive reset.
const additions: Record<string, Record<string, string>> = {
  connections: {
    paused: 'INTEGER NOT NULL DEFAULT 0',
    scope: "TEXT NOT NULL DEFAULT 'personal'",
    tags: "TEXT NOT NULL DEFAULT '[]'",
  },
  clients: { expires_at: 'TEXT' },
  grants: { visibility: 'TEXT' },
  tasks: {
    actor_kind: "TEXT NOT NULL DEFAULT 'client'", actor_id: 'TEXT',
    input_ciphertext: 'TEXT', result_ciphertext: 'TEXT',
    no_cache: 'INTEGER NOT NULL DEFAULT 0', safe_retry: 'INTEGER NOT NULL DEFAULT 0',
    attempts: 'INTEGER NOT NULL DEFAULT 0', max_attempts: 'INTEGER NOT NULL DEFAULT 3',
    available_at: 'TEXT', lease_owner: 'TEXT', lease_expires_at: 'TEXT', heartbeat_at: 'TEXT',
    cancel_requested_at: 'TEXT', cancellation: 'TEXT',
  },
};
db.transaction(() => {
  for (const [table, columns] of Object.entries(additions)) {
    const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
    for (const [name, definition] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
  const clientColumns = db.prepare('PRAGMA table_info(clients)').all() as Array<{ name: string }>;
  if (clientColumns.some((column) => column.name === 'kind')) {
    // Resolve the old implicit defaults before removing transport labels.
    // Hold the write reservation while checking ownership and migrating, so
    // another worker cannot acquire a lease between that check and the DDL.
    const lease = db.prepare("SELECT expires_at FROM og_service_lease WHERE slot='primary'").get() as { expires_at: number } | undefined;
    if (lease && lease.expires_at > Date.now()) throw new Error('Stop the active server or maintenance process before migrating client identities');
    const grants = db.prepare(`SELECT g.client_id, g.connection_id, g.visibility, c.kind
      FROM grants AS g JOIN clients AS c ON c.id=g.client_id`).all() as Array<{
        client_id: string; connection_id: string; visibility: string | null; kind: string;
      }>;
    const update = db.prepare('UPDATE grants SET visibility=? WHERE client_id=? AND connection_id=?');
    for (const grant of grants) {
      const saved: unknown = grant.visibility === null ? {} : JSON.parse(grant.visibility);
      if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) throw new Error('Stored client visibility is invalid');
      const policy = saved as Record<string, unknown>;
      for (const key of ['pii', 'financial', 'content']) {
        if (policy[key] !== undefined && typeof policy[key] !== 'boolean') throw new Error('Stored client visibility is invalid');
      }
      update.run(JSON.stringify({
        pii: policy['pii'] ?? (grant.kind === 'cli' || grant.kind === 'admin'),
        financial: policy['financial'] ?? true,
        content: policy['content'] ?? true,
      }), grant.client_id, grant.connection_id);
    }
    db.exec('ALTER TABLE clients DROP COLUMN kind');
  }
  db.exec('CREATE INDEX IF NOT EXISTS tasks_pending_idx ON tasks(status, available_at, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS tasks_lease_idx ON tasks(status, lease_expires_at)');
  db.exec('CREATE INDEX IF NOT EXISTS tasks_actor_idx ON tasks(actor_kind, actor_id, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events(task_id, id)');
}).immediate();

const orm = drizzle(db, { schema });
let boundLease: string | undefined;

function assertLease(owner = boundLease): void {
  if (!owner) return;
  const lease = db.prepare("SELECT owner, expires_at FROM og_service_lease WHERE slot='primary'").get() as { owner: string; expires_at: number } | undefined;
  if (!lease || lease.owner !== owner || lease.expires_at <= Date.now()) throw new Error('Database service lease was lost or expired');
}

parentPort.on('message', async (req: DbRequest) => {
  const { id, method, args } = req;
  try {
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown DB method: ${method}`);
    // Validate ownership after acquiring SQLite's write reservation. Checking
    // before a busy wait would let an expired owner write after a takeover.
    const result = boundLease
      ? db.transaction(() => { assertLease(); return handler(args); }).immediate()
      : handler(args);
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

type Handler = (args: unknown) => unknown;
const handlers: Record<string, Handler> = {

  bindLease(args) {
    const { owner } = args as { owner: string };
    if (!owner || (boundLease && boundLease !== owner)) throw new Error('Cannot change a bound database lease');
    assertLease(owner);
    boundLease = owner;
  },

  // Connectors
  upsertConnector(args) {
    const { id, version, title, transport, manifest } = args as typeof schema.connectors.$inferInsert;
    return orm.insert(schema.connectors)
      .values({ id, version, title, transport, manifest })
      .onConflictDoUpdate({ target: schema.connectors.id, set: { version, title, manifest } })
      .returning()
      .get();
  },

  listConnectors() {
    return orm.select().from(schema.connectors).all();
  },

  // Connections
  createConnection(args) {
    const val = args as typeof schema.connections.$inferInsert;
    return orm.insert(schema.connections).values(val).returning().get();
  },

  getConnection(args) {
    const { id } = args as { id: string };
    return orm.query.connections.findFirst({ where: (c, { eq }) => eq(c.id, id) }).sync();
  },

  listConnections() {
    return orm.select().from(schema.connections).all();
  },

  deleteConnection(args) {
    // grants and credentials cascade via their foreign keys.
    const { id } = args as { id: string };
    return orm.delete(schema.connections)
      .where(eq(schema.connections.id, id))
      .returning()
      .get();
  },

  updateConnectionStates(args) {
    const { id, capability_states, updated_at } = args as {
      id: string; capability_states: unknown; updated_at: string;
    };
    return orm.update(schema.connections)
      .set({ capability_states, updated_at })
      .where(eq(schema.connections.id, id))
      .returning()
      .get();
  },

  updateConnectionConfig(args) {
    const { id, config, label } = args as { id: string; config: unknown; label?: string };
    return orm.update(schema.connections)
      .set({ config, ...(label !== undefined ? { label } : {}), updated_at: new Date().toISOString() })
      .where(eq(schema.connections.id, id)).returning().get();
  },

  // Clients
  createClient(args) {
    const val = args as typeof schema.clients.$inferInsert;
    return orm.insert(schema.clients).values(val).returning().get();
  },

  getClientByToken(args) {
    const { token_hash } = args as { token_hash: string };
    return orm.query.clients.findFirst({
      where: (c, { eq, and }) => and(eq(c.token_hash, token_hash), eq(c.revoked, false)),
    }).sync();
  },

  listClients() {
    // Includes revoked clients: callers need the flag to answer CLIENT_REVOKED.
    return orm.select().from(schema.clients).all();
  },

  revokeClient(args) {
    const { id } = args as { id: string };
    return orm.update(schema.clients)
      .set({ revoked: true })
      .where(eq(schema.clients.id, id))
      .returning()
      .get();
  },

  // Tasks
  createTask(args) {
    const val = args as typeof schema.tasks.$inferInsert;
    return orm.insert(schema.tasks).values(val).returning().get();
  },

  updateTaskStatus(args) {
    const { id, status, started_at, finished_at } = args as {
      id: string; status: string; started_at?: string; finished_at?: string;
    };
    return orm.update(schema.tasks)
      .set({ status, started_at, finished_at })
      .where(eq(schema.tasks.id, id))
      .returning()
      .get();
  },

  getTask(args) {
    const { id } = args as { id: string };
    return orm.query.tasks.findFirst({ where: (t, { eq }) => eq(t.id, id) }).sync();
  },

  // Cache
  getCacheEntry(args) {
    const { key } = args as { key: string };
    return orm.query.results_cache.findFirst({ where: (c, { eq }) => eq(c.key, key) }).sync();
  },

  setCacheEntry(args) {
    const val = args as typeof schema.results_cache.$inferInsert;
    orm.delete(schema.results_cache).where(lt(schema.results_cache.expires_at, new Date().toISOString())).run();
    return orm.insert(schema.results_cache)
      .values(val)
      .onConflictDoUpdate({ target: schema.results_cache.key, set: { ...val, cached_at: val.cached_at ?? new Date().toISOString() } })
      .returning()
      .get();
  },

  deleteCacheEntry(args) {
    const { key } = args as { key: string };
    return orm.delete(schema.results_cache)
      .where(eq(schema.results_cache.key, key))
      .returning()
      .get();
  },

  clearCache() {
    return orm.delete(schema.results_cache).run();
  },

  // Audit log
  appendAuditLog(args) {
    const val = args as typeof schema.audit_log.$inferInsert;
    return db.transaction(() => {
      const last = orm.select().from(schema.audit_log).orderBy(desc(schema.audit_log.seq)).limit(1).get();
      const prev_hash = last?.entry_hash ?? '0';
      const at = new Date().toISOString();
      const entry = { action: val.action, client_id: val.client_id ?? null, target: val.target ?? null, detail: val.detail ?? null, at };
      const entry_hash = createHash('sha256').update(`${prev_hash}|${JSON.stringify(entry)}`).digest('hex');
      return orm.insert(schema.audit_log).values({ ...entry, prev_hash, entry_hash }).returning().get();
    })();
  },

  getLastAuditEntry() {
    return orm.select().from(schema.audit_log)
      .orderBy(desc(schema.audit_log.seq))
      .limit(1)
      .get();
  },

  // Grants
  upsertGrant(args) {
    // (client_id, connection_id) is the primary key: a second grant for the
    // same pair replaces the capability list instead of failing.
    const val = args as typeof schema.grants.$inferInsert;
    return orm.insert(schema.grants)
      .values(val)
      .onConflictDoUpdate({
        target: [schema.grants.client_id, schema.grants.connection_id],
        set: { capabilities: val.capabilities, visibility: val.visibility ?? null },
      })
      .returning()
      .get();
  },

  getGrants(args) {
    const { client_id } = args as { client_id: string };
    return orm.query.grants.findMany({
      where: (g, { eq }) => eq(g.client_id, client_id),
    }).sync();
  },

  listGrants() {
    return orm.select().from(schema.grants).all();
  },

  // Admin users (auth)
  getAdminByUsername(args) {
    const { username } = args as { username: string };
    return orm.query.admin_users.findFirst({ where: (u, { eq }) => eq(u.username, username) }).sync();
  },

  getAdminById(args) {
    const { id } = args as { id: string };
    return orm.query.admin_users.findFirst({ where: (u, { eq }) => eq(u.id, id) }).sync();
  },

  countAdminUsers() {
    const row = orm.select({ n: count() }).from(schema.admin_users).get();
    return row?.n ?? 0;
  },

  createAdminUser(args) {
    const val = args as typeof schema.admin_users.$inferInsert;
    return orm.insert(schema.admin_users).values(val).returning().get();
  },

  updateAdminPassword(args) {
    const { id, password_hash } = args as { id: string; password_hash: string };
    return orm.update(schema.admin_users)
      .set({ password_hash })
      .where(eq(schema.admin_users.id, id))
      .returning()
      .get();
  },

  setTotpEnabled(args) {
    const { id, totp_enabled } = args as { id: string; totp_enabled: boolean };
    return orm.update(schema.admin_users)
      .set({ totp_enabled })
      .where(eq(schema.admin_users.id, id))
      .returning()
      .get();
  },

  // TOTP secrets (encrypted via Vault)
  getTotpSecret(args) {
    const { user_id } = args as { user_id: string };
    return orm.query.totp_secrets.findFirst({ where: (t, { eq }) => eq(t.user_id, user_id) }).sync();
  },

  upsertTotpSecret(args) {
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

  deleteTotpSecret(args) {
    const { user_id } = args as { user_id: string };
    return orm.delete(schema.totp_secrets)
      .where(eq(schema.totp_secrets.user_id, user_id))
      .returning()
      .get();
  },

  // WebAuthn credentials
  listWebauthnCredentials(args) {
    const { user_id } = args as { user_id: string };
    return orm.select().from(schema.webauthn_credentials)
      .where(eq(schema.webauthn_credentials.user_id, user_id))
      .all();
  },

  getWebauthnCredentialByCredentialId(args) {
    const { credential_id } = args as { credential_id: string };
    return orm.query.webauthn_credentials.findFirst({
      where: (c, { eq }) => eq(c.credential_id, credential_id),
    }).sync();
  },

  insertWebauthnCredential(args) {
    const val = args as typeof schema.webauthn_credentials.$inferInsert;
    return orm.insert(schema.webauthn_credentials).values(val).returning().get();
  },

  updateWebauthnCounter(args) {
    const { credential_id, counter } = args as { credential_id: string; counter: number };
    return orm.update(schema.webauthn_credentials)
      .set({ counter })
      .where(eq(schema.webauthn_credentials.credential_id, credential_id))
      .returning()
      .get();
  },

  deleteWebauthnCredential(args) {
    const { id, user_id } = args as { id: string; user_id: string };
    return orm.delete(schema.webauthn_credentials)
      .where(and(
        eq(schema.webauthn_credentials.id, id),
        eq(schema.webauthn_credentials.user_id, user_id),
      ))
      .returning()
      .get();
  },

  // Connection credentials
  upsertCredential(args) {
    const val = args as typeof schema.credentials.$inferInsert;
    return orm.insert(schema.credentials)
      .values({ ...val, updated_at: new Date().toISOString() })
      .onConflictDoUpdate({
        target: [schema.credentials.connection_id, schema.credentials.key],
        set: {
          ciphertext: val.ciphertext,
          iv: val.iv,
          auth_tag: val.auth_tag,
          updated_at: new Date().toISOString(),
        },
      })
      .run();
  },

  listCredentials(args) {
    const { connection_id } = args as { connection_id: string };
    return orm.select({
      key: schema.credentials.key,
      ciphertext: schema.credentials.ciphertext,
      iv: schema.credentials.iv,
      auth_tag: schema.credentials.auth_tag,
      updated_at: schema.credentials.updated_at,
    })
      .from(schema.credentials)
      .where(eq(schema.credentials.connection_id, connection_id))
      .all();
  },

  listAllCredentials() {
    return orm.select({
      connection_id: schema.credentials.connection_id,
      key: schema.credentials.key,
      ciphertext: schema.credentials.ciphertext,
      iv: schema.credentials.iv,
      auth_tag: schema.credentials.auth_tag,
    })
      .from(schema.credentials)
      .all();
  },

  deleteCredentials(args) {
    const { connection_id } = args as { connection_id: string };
    return orm.delete(schema.credentials)
      .where(eq(schema.credentials.connection_id, connection_id))
      .run();
  },

  // Login sessions
  insertLoginSession(args) {
    const val = args as typeof schema.login_sessions.$inferInsert;
    return orm.insert(schema.login_sessions).values(val).returning().get();
  },

  getLoginSession(args) {
    const { id } = args as { id: string };
    return orm.query.login_sessions.findFirst({ where: (s, { eq }) => eq(s.id, id) }).sync();
  },

  deleteLoginSession(args) {
    const { id } = args as { id: string };
    return orm.delete(schema.login_sessions)
      .where(eq(schema.login_sessions.id, id))
      .returning()
      .get();
  },

  deleteLoginSessionsForUser(args) {
    const { user_id } = args as { user_id: string };
    return orm.delete(schema.login_sessions)
      .where(eq(schema.login_sessions.user_id, user_id))
      .returning()
      .all();
  },

  deleteExpiredLoginSessions(args) {
    // expires_at is always written by the auth service in ISO-8601 (UTC) form,
    // so a lexicographic comparison against another ISO string is chronological.
    const { now } = args as { now: string };
    return orm.delete(schema.login_sessions)
      .where(lt(schema.login_sessions.expires_at, now))
      .returning()
      .all();
  },

  // Raw query escape hatch for migrations / admin
  rawQuery(args) {
    const { sql, params } = args as { sql: string; params?: unknown[] };
    return db.prepare(sql).all(...(params ?? []) as Parameters<typeof db.prepare>[0][]);
  },

  rawRun(args) {
    const { sql, params } = args as RawStatement;
    return db.prepare(sql).run(...(params ?? []));
  },

  rawTransaction(args) {
    const { queries } = args as { queries: RawStatement[] };
    return db.transaction(() => queries.map(({ sql, params = [], mode = 'run', expectChanges }) => {
      const statement = db.prepare(sql);
      if (mode === 'all') return statement.all(...params);
      if (mode === 'get') return statement.get(...params);
      const result = statement.run(...params);
      if (expectChanges !== undefined && result.changes !== expectChanges) throw new Error('Atomic statement changed an unexpected number of rows');
      return result;
    })).immediate();
  },
};
