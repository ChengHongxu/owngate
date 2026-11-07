import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbClient } from '../src/client.js';
import { acquireDbLease } from '../src/lease.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'owngate-db-lease-'));
  const first = new DbClient(join(directory, 'database.db'));
  await first.rawQuery('SELECT 1');
  const second = new DbClient(join(directory, 'database.db'));
  await second.rawQuery('SELECT 1');
  cleanup.push(async () => { await first.close(); await second.close(); rmSync(directory, { recursive: true, force: true }); });
  return { first, second };
}

describe('database service and maintenance fencing', () => {
  it('allows one active owner and rejects a second server or maintenance process', async () => {
    const { first, second } = await fixture();
    const lease = await acquireDbLease(first, { mode: 'server' });
    cleanup.push(() => lease.release());
    await expect(acquireDbLease(second, { mode: 'server' })).rejects.toThrow('active server or maintenance');
    await expect(acquireDbLease(second, { mode: 'maintenance' })).rejects.toThrow('active server or maintenance');
    await lease.release();
    const maintenance = await acquireDbLease(second, { mode: 'maintenance' });
    cleanup.push(() => maintenance.release());
    expect(await second.rawQuery('SELECT mode FROM og_service_lease')).toEqual([{ mode: 'maintenance' }]);
  });

  it('fences every old-worker SQL path after expiry and takeover, including RETURNING', async () => {
    const { first, second } = await fixture();
    const old = await acquireDbLease(first, { mode: 'server' });
    await second.rawRun("UPDATE og_service_lease SET expires_at=0 WHERE slot='primary'");
    const current = await acquireDbLease(second, { mode: 'maintenance' });
    cleanup.push(() => current.release());
    await expect(first.rawRun('CREATE TABLE forbidden_one(id TEXT)')).rejects.toThrow('lease');
    await expect(first.rawQuery("UPDATE og_service_lease SET mode='server' RETURNING owner")).rejects.toThrow('lease');
    await expect(first.rawTransaction([{ sql: 'CREATE TABLE forbidden_two(id TEXT)' }])).rejects.toThrow('lease');
    await expect(old.renew()).rejects.toThrow('lease');
    await old.release();
    expect(await second.rawQuery('SELECT owner FROM og_service_lease')).toEqual([{ owner: current.owner }]);
    expect(await second.rawQuery("SELECT name FROM sqlite_master WHERE name LIKE 'forbidden_%'")).toEqual([]);
  });

  it('heartbeats renew ownership and notify a single loss without reviving an expired lease', async () => {
    const { first, second } = await fixture();
    const lease = await acquireDbLease(first, { mode: 'server', ttlMs: 300 });
    const lost = vi.fn();
    lease.start(lost);
    cleanup.push(() => lease.release());
    const initial = await second.rawQuery('SELECT expires_at FROM og_service_lease');
    await expect.poll(() => second.rawQuery('SELECT expires_at FROM og_service_lease'), { interval: 30 }).not.toEqual(initial);
    await second.rawRun("UPDATE og_service_lease SET expires_at=0 WHERE slot='primary'");
    await expect.poll(() => lost.mock.calls.length, { interval: 30 }).toBe(1);
    await expect(lease.renew()).rejects.toThrow('no longer active');
  });

  it('preserves all-or-nothing transactions while a worker is bound', async () => {
    const { first } = await fixture();
    const lease = await acquireDbLease(first, { mode: 'maintenance' });
    cleanup.push(() => lease.release());
    await expect(first.rawTransaction([
      { sql: "INSERT INTO tasks(id,client_id,connection_id,capability_id,status) VALUES('rollback-bound','client','conn','cap','pending')" },
      { sql: 'INSERT INTO absent_table VALUES(1)' },
    ])).rejects.toThrow();
    expect(await first.rawQuery("SELECT id FROM tasks WHERE id='rollback-bound'")).toEqual([]);
  });
});

describe('materialized ORM reads under a fenced transaction', () => {
  it('returns plain rows for every relational-query handler, including admin login and sessions', async () => {
    const { first } = await fixture();
    await first.upsertConnector({ id: 'fixture', title: 'Fixture', version: '1', transport: 'http', manifest: {} });
    await first.createConnection({ id: 'conn', connector_id: 'fixture', label: 'Fixture', config: {} });
    await first.createClient({ id: 'client', label: 'Fixture', token_hash: 'fixture-hash' });
    await first.upsertGrant({ client_id: 'client', connection_id: 'conn', capabilities: ['read'] });
    await first.createTask({ id: 'task', client_id: 'client', connection_id: 'conn', capability_id: 'read', input: {}, status: 'pending' });
    await first.setCacheEntry({ key: 'cache', ciphertext: 'fixture', iv: 'fixture', auth_tag: 'fixture', expires_at: '2100-01-01' });
    await first.createAdminUser({ id: 'admin', username: 'fixture-admin', password_hash: 'fixture-hash' });
    await first.insertLoginSession({ id: 'session', user_id: 'admin', expires_at: '2100-01-01' });
    await first.upsertTotpSecret({ user_id: 'admin', ciphertext: 'fixture', iv: 'fixture', auth_tag: 'fixture' });
    await first.insertWebauthnCredential({ id: 'passkey', user_id: 'admin', credential_id: 'fixture-id', public_key: 'fixture-key', counter: 0, transports: [] });
    const lease = await acquireDbLease(first, { mode: 'server' });
    cleanup.push(() => lease.release());
    const rows = await Promise.all([
      first.getConnection('conn'), first.getClientByToken('fixture-hash'), first.getGrants('client'),
      first.getTask('task'), first.getCacheEntry('cache'), first.getAdminByUsername('fixture-admin'),
      first.getAdminById('admin'), first.getTotpSecret('admin'), first.getWebauthnCredentialByCredentialId('fixture-id'), first.getLoginSession('session'),
    ]);
    expect(rows.every((row) => row !== undefined)).toBe(true);
    expect(rows[2]).toMatchObject([{ client_id: 'client' }]);
    expect(rows[5]).toMatchObject({ id: 'admin' });
    expect(rows[9]).toMatchObject({ user_id: 'admin' });
  });
});
