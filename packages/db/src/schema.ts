// Drizzle schema definitions for all tables (design doc §14).
// All tables live in one SQLite file, accessed via a single worker_thread (D2).

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ── 连接器与连接 ──────────────────────────────────────────

export const connectors = sqliteTable('connectors', {
  id: text('id').primaryKey(),
  version: text('version').notNull(),
  title: text('title').notNull(),
  transport: text('transport').notNull(),
  manifest: text('manifest', { mode: 'json' }).notNull(),
  created_at: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const connections = sqliteTable('connections', {
  id: text('id').primaryKey(),
  connector_id: text('connector_id').notNull().references(() => connectors.id),
  label: text('label').notNull(),
  config: text('config', { mode: 'json' }).notNull(),
  capability_states: text('capability_states', { mode: 'json' }).notNull().default({}),
  created_at: text('created_at').notNull().default(sql`(datetime('now'))`),
  updated_at: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// ── 凭据（加密存储）──────────────────────────────────────

export const credentials = sqliteTable('credentials', {
  connection_id: text('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  ciphertext: text('ciphertext').notNull(), // base64
  iv: text('iv').notNull(), // base64
  auth_tag: text('auth_tag').notNull(), // base64
  updated_at: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// ── 客户端与授权 ──────────────────────────────────────────

export const clients = sqliteTable('clients', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  kind: text('kind').notNull(), // mcp | cli | admin | cron
  token_hash: text('token_hash').notNull(),
  revoked: integer('revoked', { mode: 'boolean' }).notNull().default(false),
  created_at: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const grants = sqliteTable('grants', {
  client_id: text('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  connection_id: text('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  capabilities: text('capabilities', { mode: 'json' }).notNull(), // string[] or ['*']
  created_at: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ── 任务 ──────────────────────────────────────────────────

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  client_id: text('client_id').notNull(),
  connection_id: text('connection_id').notNull(),
  capability_id: text('capability_id').notNull(),
  input: text('input', { mode: 'json' }).notNull(),
  status: text('status').notNull(), // pending|running|success|partial|failed|cancelled|unknown_outcome
  created_at: text('created_at').notNull().default(sql`(datetime('now'))`),
  started_at: text('started_at'),
  finished_at: text('finished_at'),
});

export const task_events = sqliteTable('task_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  task_id: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  event: text('event').notNull(), // created|started|progress|finished|cancelled|error
  detail: text('detail', { mode: 'json' }),
  at: text('at').notNull().default(sql`(datetime('now'))`),
});

// ── 写操作提案与批准（D9 框架，本期不开放）─────────────────

export const action_proposals = sqliteTable('action_proposals', {
  id: text('id').primaryKey(),
  client_id: text('client_id').notNull(),
  connection_id: text('connection_id').notNull(),
  capability_id: text('capability_id').notNull(),
  input: text('input', { mode: 'json' }).notNull(),
  normalized_hash: text('normalized_hash').notNull(), // content hash, binding approval
  status: text('status').notNull(), // pending|approved|rejected|executed|stale
  created_at: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const approvals = sqliteTable('approvals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  proposal_id: text('proposal_id').notNull().references(() => action_proposals.id, { onDelete: 'cascade' }),
  approved_by: text('approved_by').notNull(),
  approved_hash: text('approved_hash').notNull(),
  at: text('at').notNull().default(sql`(datetime('now'))`),
});

// ── 结果缓存（加密）──────────────────────────────────────

export const results_cache = sqliteTable('results_cache', {
  key: text('key').primaryKey(), // hash of (connection, capability, input)
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  auth_tag: text('auth_tag').notNull(),
  cached_at: text('cached_at').notNull().default(sql`(datetime('now'))`),
  expires_at: text('expires_at').notNull(),
});

// ── 监控与通知 ────────────────────────────────────────────

export const monitors = sqliteTable('monitors', {
  id: text('id').primaryKey(),
  connection_id: text('connection_id').notNull(),
  capability_id: text('capability_id').notNull(),
  cron: text('cron').notNull(),
  condition: text('condition').notNull(), // expression DSL
  channel_id: text('channel_id').notNull().references(() => notification_channels.id),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  created_at: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const notification_channels = sqliteTable('notification_channels', {
  id: text('id').primaryKey(),
  type: text('type').notNull(), // smtp
  config: text('config', { mode: 'json' }).notNull(),
  created_at: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ── 审计日志（哈希链，只追加）────────────────────────────

export const audit_log = sqliteTable('audit_log', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  client_id: text('client_id'),
  action: text('action').notNull(),
  target: text('target'),
  detail: text('detail', { mode: 'json' }),
  prev_hash: text('prev_hash').notNull(),
  entry_hash: text('entry_hash').notNull(),
  at: text('at').notNull().default(sql`(datetime('now'))`),
});

// ── 后台认证 ──────────────────────────────────────────────

export const admin_users = sqliteTable('admin_users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  password_hash: text('password_hash').notNull(), // argon2
  totp_enabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
  created_at: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const webauthn_credentials = sqliteTable('webauthn_credentials', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull().references(() => admin_users.id, { onDelete: 'cascade' }),
  credential_id: text('credential_id').notNull().unique(), // base64url
  public_key: text('public_key').notNull(), // base64
  counter: integer('counter').notNull().default(0),
  transports: text('transports', { mode: 'json' }).notNull().default([]),
  created_at: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const totp_secrets = sqliteTable('totp_secrets', {
  user_id: text('user_id').notNull().references(() => admin_users.id, { onDelete: 'cascade' }),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  auth_tag: text('auth_tag').notNull(),
  updated_at: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const login_sessions = sqliteTable('login_sessions', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull(),
  created_at: text('created_at').notNull().default(sql`(datetime('now'))`),
  expires_at: text('expires_at').notNull(),
});

// ── newapi 渠道与上游连接对应关系 ─────────────────────────

export const channel_upstream_links = sqliteTable('channel_upstream_links', {
  connection_id: text('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  channel_id: text('channel_id').notNull(),
  upstream_connection_id: text('upstream_connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  created_at: text('created_at').notNull().default(sql`(datetime('now'))`),
});
