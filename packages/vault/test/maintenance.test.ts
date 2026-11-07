import { afterEach, describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { DbClient, acquireDbLease } from '../../db/dist/index.js';
import { Vault, vaultContext, isEncryptedBlob, isLegacyBlob } from '../src/vault.js';
import { discoverEncryptedRecords, migrateEncryptedRecords, rekeyEncryptedRecords } from '../src/maintenance.js';
import type { VaultDatabase } from '../src/maintenance.js';

const OLD = '44'.repeat(32), NEXT = '55'.repeat(32);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function legacy(value: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(OLD, 'hex'), iv);
  return { ciphertext: Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64'), iv: iv.toString('base64'), auth_tag: cipher.getAuthTag().toString('base64') };
}
async function fixture(mode: 'server' | 'maintenance' = 'maintenance') {
  const db = new DbClient(':memory:');
  const lease = await acquireDbLease(db, { mode });
  cleanup.push(async () => { await lease.release(); await db.close(); });
  await db.upsertConnector({ id: 'fixture', version: '1', title: 'Fixture', transport: 'http', manifest: {} });
  await db.createConnection({ id: 'connection', connector_id: 'fixture', label: 'Fixture', config: {} });
  await db.upsertCredential({ connection_id: 'connection', key: 'access_token', ...legacy('legacy-sensitive-token') });
  await db.createAdminUser({ id: 'admin', username: 'admin', password_hash: 'fixture' });
  await db.upsertTotpSecret({ user_id: 'admin', ...legacy(JSON.stringify({ secretBase32: 'fixture-totp-seed' })) });
  await db.setCacheEntry({ key: 'cache', ...legacy(JSON.stringify({ private_value: 'private-cache' })), expires_at: '2100-01-01' });
  await db.createTask({ id: 'task', client_id: 'client', connection_id: 'connection', capability_id: 'read', input: { message: 'private-task-input' }, status: 'success' });
  await db.rawRun('UPDATE tasks SET result_ciphertext=? WHERE id=?', [JSON.stringify(legacy(JSON.stringify({ result: 'private-task-result' }))), 'task']);
  await db.rawTransaction([
    { sql: 'CREATE TABLE og_action_meta(proposal_id TEXT PRIMARY KEY,result TEXT)' },
    { sql: `INSERT INTO action_proposals(id,client_id,connection_id,capability_id,input,normalized_hash,status) VALUES('proposal','client','connection','write',?,'fixture','pending')`, params: [JSON.stringify(legacy(JSON.stringify({ body: 'private-action-input' })))] },
    { sql: 'INSERT INTO og_action_meta(proposal_id,result) VALUES(?,?)', params: ['proposal', JSON.stringify(legacy(JSON.stringify({ result: 'private-action-result' })))] },
    { sql: 'INSERT INTO notification_channels(id,type,config) VALUES(?,?,?)', params: ['channel', 'smtp', JSON.stringify({ host: 'fixture.invalid', pass: legacy('private-smtp-password'), to: ['private@example.test'] })] },
    { sql: `CREATE TABLE monitor_runtime(monitor_id TEXT PRIMARY KEY,config TEXT,state TEXT)` },
    { sql: 'INSERT INTO monitor_runtime(monitor_id,config,state) VALUES(?,?,?)', params: ['monitor', JSON.stringify({ input: { value: 'private-monitor-input' } }), JSON.stringify({ pending: 'private-monitor-message' })] },
  ]);
  return { db, lease, oldVault: new Vault(OLD), nextVault: new Vault(NEXT) };
}
async function snapshot(db: DbClient) {
  return JSON.stringify(await db.rawTransaction([
    { sql: 'SELECT * FROM credentials', mode: 'all' }, { sql: 'SELECT * FROM tasks', mode: 'all' },
    { sql: 'SELECT * FROM results_cache', mode: 'all' }, { sql: 'SELECT * FROM notification_channels', mode: 'all' },
    { sql: 'SELECT * FROM audit_log', mode: 'all' },
  ]));
}

describe('vault upgrades and atomic offline rekey', () => {
  it('upgrades every persisted category, binds its context and removes legacy plaintext', async () => {
    const { db, lease, oldVault } = await fixture('server');
    const result = await migrateEncryptedRecords(db, oldVault, { heartbeat: () => lease.renew() });
    expect(result.upgraded).toBe(11);
    const records = await discoverEncryptedRecords(db);
    expect(records).toHaveLength(11);
    expect(records.every((record) => record.blob && !isLegacyBlob(record.blob))).toBe(true);
    expect(await db.rawQuery("SELECT input FROM tasks WHERE id='task'")).toEqual([{ input: '{}' }]);
    const [channel] = await db.rawQuery("SELECT config FROM notification_channels WHERE id='channel'") as Array<{ config: string }>;
    const decrypted = oldVault.decryptJSON<{ pass: string }>(JSON.parse(channel!.config), vaultContext.notification('channel'));
    expect(decrypted.pass).toBe('private-smtp-password');
    expect(isEncryptedBlob(decrypted.pass)).toBe(false);
    const raw = await snapshot(db);
    expect(raw).not.toContain('private-task-input');
    expect(raw).not.toContain('private@example.test');
    expect(await migrateEncryptedRecords(db, oldVault)).toMatchObject({ upgraded: 0 });
  });

  it('rotates all records in one transaction and keeps the new key bound to every identity', async () => {
    const { db, lease, oldVault, nextVault } = await fixture();
    await migrateEncryptedRecords(db, oldVault);
    const result = await rekeyEncryptedRecords(db, oldVault, nextVault, { heartbeat: () => lease.renew() });
    expect(result.upgraded).toBe(11);
    for (const record of await discoverEncryptedRecords(db)) {
      expect(() => nextVault.decrypt(record.blob!, record.context)).not.toThrow();
      expect(() => oldVault.decrypt(record.blob!, record.context)).toThrow();
      expect(() => nextVault.decrypt(record.blob!, ['moved', record.context[1], record.context[2]])).toThrow();
    }
    expect(await migrateEncryptedRecords(db, nextVault)).toMatchObject({ upgraded: 0 });
    expect((await db.getLastAuditEntry()) as { action: string }).toMatchObject({ action: 'vault.rekey' });
  });

  it('writes nothing when the old key cannot decrypt even one record', async () => {
    const { db, oldVault, nextVault } = await fixture();
    await migrateEncryptedRecords(db, oldVault);
    const before = await snapshot(db);
    await expect(rekeyEncryptedRecords(db, new Vault('66'.repeat(32)), nextVault)).rejects.toThrow('wrong key');
    expect(await snapshot(db)).toBe(before);
  });

  it('rolls back every ciphertext if the commit batch fails partway through', async () => {
    const { db, oldVault, nextVault } = await fixture();
    await migrateEncryptedRecords(db, oldVault);
    const before = await snapshot(db);
    const failed: VaultDatabase = {
      rawQuery: (sql, params) => db.rawQuery(sql, params),
      rawTransaction: (queries) => db.rawTransaction([...queries, { sql: 'INSERT INTO missing_table VALUES(1)' }]),
    };
    await expect(rekeyEncryptedRecords(failed, oldVault, nextVault)).rejects.toThrow();
    expect(await snapshot(db)).toBe(before);
    for (const record of await discoverEncryptedRecords(db)) expect(() => oldVault.decrypt(record.blob!, record.context)).not.toThrow();
  });

  it('refuses online key rotation while the server owns the database', async () => {
    const { db, oldVault, nextVault } = await fixture('server');
    await migrateEncryptedRecords(db, oldVault);
    const before = await snapshot(db);
    await expect(rekeyEncryptedRecords(db, oldVault, nextVault)).rejects.toThrow('offline maintenance lease');
    expect(await snapshot(db)).toBe(before);
  });
});
