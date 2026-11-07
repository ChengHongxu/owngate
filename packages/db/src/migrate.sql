-- Initial schema migration for owngate
-- Executed by the DB worker on startup via db.exec() (better-sqlite3)

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- A single server or offline maintenance owner. Bound worker calls are fenced
-- against this row, so an old process cannot write after its lease expires.
CREATE TABLE IF NOT EXISTS og_service_lease (
  slot TEXT PRIMARY KEY CHECK (slot = 'primary'),
  owner TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('server', 'maintenance')),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  title TEXT NOT NULL,
  transport TEXT NOT NULL,
  manifest TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connectors(id),
  label TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  capability_states TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS credentials (
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (connection_id, key)
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS grants (
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  capabilities TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (client_id, connection_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS action_proposals (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '{}',
  normalized_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id TEXT NOT NULL REFERENCES action_proposals(id) ON DELETE CASCADE,
  approved_by TEXT NOT NULL,
  approved_hash TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS results_cache (
  key TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  cached_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  cron TEXT NOT NULL,
  condition TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES notification_channels(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notification_channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS totp_secrets (
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id)
);

CREATE TABLE IF NOT EXISTS login_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_upstream_links (
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  upstream_connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (connection_id, channel_id)
);

CREATE TABLE IF NOT EXISTS comparison_links (
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  view_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  target_connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (connection_id, view_id, item_id)
);

CREATE TABLE IF NOT EXISTS og_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Copy legacy associations once. Keeping a marker prevents a deliberately
-- deleted generic association from reappearing when the server restarts.
BEGIN IMMEDIATE;
INSERT OR IGNORE INTO comparison_links(connection_id,view_id,item_id,target_connection_id,created_at)
SELECT connection_id,'channel-upstreams',channel_id,upstream_connection_id,created_at
FROM channel_upstream_links
WHERE NOT EXISTS (SELECT 1 FROM og_schema_migrations WHERE id='comparison_links_v1');
INSERT OR IGNORE INTO og_schema_migrations(id) VALUES('comparison_links_v1');
COMMIT;
