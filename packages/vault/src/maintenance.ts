import { createHash } from 'node:crypto';
import { Vault, vaultContext, isEncryptedBlob, isLegacyBlob } from './vault.js';
import type { EncryptedBlob, VaultContext } from './vault.js';

export interface VaultStatement { sql: string; params?: unknown[]; mode?: 'run' | 'get' | 'all'; expectChanges?: number }
export interface VaultDatabase {
  rawQuery(sql: string, params?: unknown[]): Promise<unknown[]>;
  rawTransaction(queries: VaultStatement[]): Promise<unknown[]>;
}
export interface EncryptedRecord {
  readonly table: string;
  readonly column: string;
  readonly context: VaultContext;
  readonly encoding: 'text' | 'json';
  readonly blob: EncryptedBlob | null;
  readonly legacyValue?: unknown;
  readonly forceUpgrade?: boolean;
  write(blob: EncryptedBlob): VaultStatement;
}
export interface VaultMaintenanceOptions { heartbeat?: () => Promise<void> }
export interface VaultMaintenanceResult { records: number; upgraded: number }

function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; }
  catch { throw new Error('A persisted vault record is malformed; no encryption changes were written'); }
}
function blobCell(value: unknown): { blob: EncryptedBlob | null; legacyValue?: unknown } {
  const object = parsed(value);
  return isEncryptedBlob(object) ? { blob: object } : { blob: null, legacyValue: object };
}

/** Trusted host/server use only. This returns ciphertext and legacy private data. */
export async function discoverEncryptedRecords(db: VaultDatabase): Promise<EncryptedRecord[]> {
  const tables = new Set((await db.rawQuery("SELECT name FROM sqlite_master WHERE type='table'") as Array<{ name: string }>).map((row) => row.name));
  const records: EncryptedRecord[] = [];
  const columns = async (table: string, keys: string[], context: (row: Record<string, unknown>) => VaultContext) => {
    if (!tables.has(table)) return;
    for (const row of await db.rawQuery(`SELECT * FROM ${table}`) as Array<Record<string, unknown>>) {
      if (!isEncryptedBlob(row)) throw new Error(`Invalid encrypted record in ${table}`);
      const encrypted = { ciphertext: row.ciphertext, iv: row.iv, auth_tag: row.auth_tag };
      records.push({ table, column: 'ciphertext', context: context(row), encoding: 'text', blob: encrypted,
        write: (blob) => ({ sql: `UPDATE ${table} SET ciphertext=?,iv=?,auth_tag=? WHERE ${keys.map((key) => `${key}=?`).join(' AND ')}`,
          params: [blob.ciphertext, blob.iv, blob.auth_tag, ...keys.map((key) => row[key])], expectChanges: 1 }) });
    }
  };
  await columns('credentials', ['connection_id', 'key'], (row) => vaultContext.credential(String(row['connection_id']), String(row['key'])));
  await columns('totp_secrets', ['user_id'], (row) => vaultContext.totp(String(row['user_id'])));
  await columns('results_cache', ['key'], (row) => vaultContext.cache(String(row['key'])));

  if (tables.has('tasks')) {
    for (const row of await db.rawQuery('SELECT id,input,input_ciphertext,result_ciphertext FROM tasks') as Array<Record<string, unknown>>) {
      const id = String(row['id']);
      const input = row['input_ciphertext'] ? blobCell(row['input_ciphertext']) : { blob: null, legacyValue: parsed(row['input']) };
      records.push({ table: 'tasks', column: 'input_ciphertext', context: vaultContext.task(id, 'input'), encoding: 'json', ...input,
        forceUpgrade: row['input'] !== '{}',
        write: (blob) => ({ sql: "UPDATE tasks SET input_ciphertext=?,input='{}' WHERE id=?", params: [JSON.stringify(blob), id], expectChanges: 1 }) });
      if (row['result_ciphertext']) records.push({ table: 'tasks', column: 'result_ciphertext', context: vaultContext.task(id, 'result'), encoding: 'json', ...blobCell(row['result_ciphertext']),
        write: (blob) => ({ sql: 'UPDATE tasks SET result_ciphertext=? WHERE id=?', params: [JSON.stringify(blob), id], expectChanges: 1 }) });
    }
  }
  const json = async (table: string, key: string, column: string, context: (id: string) => VaultContext) => {
    if (!tables.has(table)) return;
    for (const row of await db.rawQuery(`SELECT ${key},${column} FROM ${table} WHERE ${column} IS NOT NULL`) as Array<Record<string, unknown>>) {
      const id = String(row[key]);
      records.push({ table, column, context: context(id), encoding: 'json', ...blobCell(row[column]),
        write: (blob) => ({ sql: `UPDATE ${table} SET ${column}=? WHERE ${key}=?`, params: [JSON.stringify(blob), id], expectChanges: 1 }) });
    }
  };
  await json('action_proposals', 'id', 'input', (id) => vaultContext.action(id, 'input'));
  await json('og_action_meta', 'proposal_id', 'result', (id) => vaultContext.action(id, 'result'));
  await json('notification_channels', 'id', 'config', vaultContext.notification);
  await json('monitor_runtime', 'monitor_id', 'config', (id) => vaultContext.monitor(id, 'config'));
  await json('monitor_runtime', 'monitor_id', 'state', (id) => vaultContext.monitor(id, 'state'));

  const checks = tables.has('og_vault_meta') ? await db.rawQuery("SELECT value FROM og_vault_meta WHERE key='key_check'") as Array<{ value: string }> : [];
  const existingCheck = checks[0];
  records.push({ table: 'og_vault_meta', column: 'value', context: vaultContext.keyCheck(), encoding: 'json',
    ...(existingCheck ? blobCell(existingCheck.value) : { blob: null, legacyValue: 'owngate.vault.v2' }),
    write: (blob) => ({ sql: `INSERT INTO og_vault_meta(key,value) VALUES('key_check',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      params: [JSON.stringify(blob)], expectChanges: 1 }) });
  return records;
}

async function assertOwner(db: VaultDatabase, maintenance: boolean): Promise<void> {
  const [lease] = await db.rawQuery("SELECT mode,expires_at FROM og_service_lease WHERE slot='primary'") as Array<{ mode: string; expires_at: number }>;
  if (!lease || lease.expires_at <= Date.now() || (maintenance && lease.mode !== 'maintenance')) {
    throw new Error(maintenance ? 'Vault rotation requires an active offline maintenance lease' : 'Vault migration requires an active database owner lease');
  }
}

async function rewrite(db: VaultDatabase, oldVault: Vault, newVault: Vault, rotate: boolean, options: VaultMaintenanceOptions): Promise<VaultMaintenanceResult> {
  await assertOwner(db, rotate);
  const records = await discoverEncryptedRecords(db);
  const writes: VaultStatement[] = [{ sql: 'CREATE TABLE IF NOT EXISTS og_vault_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)' }];
  let upgraded = 0;
  for (const [index, record] of records.entries()) {
    let value: unknown = record.blob
      ? record.encoding === 'json' ? oldVault.decryptJSON(record.blob, record.context) : oldVault.decrypt(record.blob, record.context)
      : structuredClone(record.legacyValue);
    let nestedUpgrade = false;
    // Older SMTP rows encrypted only their password. Move its plaintext into
    // the fully encrypted config, so rekey never leaves an old-key inner blob.
    if (record.table === 'notification_channels' && value && typeof value === 'object' && !Array.isArray(value)) {
      const config = value as Record<string, unknown>;
      if (isEncryptedBlob(config['pass'])) {
        config['pass'] = oldVault.decrypt(config['pass'], vaultContext.notificationPassword(record.context[1]));
        nestedUpgrade = true;
      }
    }
    if (record.table === 'og_vault_meta' && value !== 'owngate.vault.v2') throw new Error('Vault key verification failed; no encryption changes were written');
    if (rotate || !record.blob || isLegacyBlob(record.blob) || record.forceUpgrade || nestedUpgrade) {
      const encrypted = record.encoding === 'text' ? newVault.encrypt(String(value), record.context) : newVault.encryptJSON(value, record.context);
      writes.push(record.write(encrypted));
      upgraded++;
    }
    if (index % 64 === 0) {
      if (options.heartbeat) await options.heartbeat();
      await new Promise<void>((done) => setImmediate(done));
    }
  }
  if (upgraded === 0) return { records: records.length, upgraded: 0 };
  const [last] = await db.rawQuery('SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1') as Array<{ entry_hash: string }>;
  const prev_hash = last?.entry_hash ?? '0';
  const at = new Date().toISOString();
  const detail = { records: upgraded, format: 2 };
  const entry = { action: rotate ? 'vault.rekey' : 'vault.migrate', client_id: null, target: 'vault', detail, at };
  const entry_hash = createHash('sha256').update(`${prev_hash}|${JSON.stringify(entry)}`).digest('hex');
  writes.push({ sql: 'INSERT INTO audit_log(action,client_id,target,detail,prev_hash,entry_hash,at) VALUES(?,NULL,?,?,?,?,?)',
    params: [entry.action, entry.target, JSON.stringify(detail), prev_hash, entry_hash, at], expectChanges: 1 });
  if (options.heartbeat) await options.heartbeat();
  await db.rawTransaction(writes);
  return { records: records.length, upgraded };
}

/** Run before restoring credentials or starting services on an existing DB. */
export function migrateEncryptedRecords(db: VaultDatabase, vault: Vault, options: VaultMaintenanceOptions = {}): Promise<VaultMaintenanceResult> {
  return rewrite(db, vault, vault, false, options);
}

/** Old and new key files must already exist before this single transaction. */
export function rekeyEncryptedRecords(db: VaultDatabase, oldVault: Vault, newVault: Vault, options: VaultMaintenanceOptions = {}): Promise<VaultMaintenanceResult> {
  return rewrite(db, oldVault, newVault, true, options);
}
