import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DbClient } from '../src/client.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

interface LegacyClient { id: string; kind: string; visibility: Record<string, boolean> | null }

function legacy(clients: LegacyClient[]) {
  const dir = mkdtempSync(join(tmpdir(), 'owngate-client-identity-'));
  const path = join(dir, 'fixture.db');
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(path);
  // Reconstruct the former client table independently of the current ORM.
  const sql = readFileSync(new URL('../src/migrate.sql', import.meta.url), 'utf8')
    .replace('CREATE TABLE IF NOT EXISTS clients (\n  id TEXT PRIMARY KEY,\n  label TEXT NOT NULL,',
      'CREATE TABLE IF NOT EXISTS clients (\n  id TEXT PRIMARY KEY,\n  label TEXT NOT NULL,\n  kind TEXT NOT NULL,');
  db.exec(sql);
  db.exec('ALTER TABLE clients ADD COLUMN expires_at TEXT; ALTER TABLE grants ADD COLUMN visibility TEXT');
  db.prepare("INSERT INTO connectors(id,version,title,transport) VALUES('fixture','1','Fixture','http')").run();
  db.prepare("INSERT INTO connections(id,connector_id,label) VALUES('connection','fixture','Existing connection')").run();
  db.prepare("INSERT INTO credentials(connection_id,key,ciphertext,iv,auth_tag) VALUES('connection','fixture','encrypted-fixture','iv','tag')").run();
  for (const client of clients) {
    db.prepare('INSERT INTO clients(id,label,kind,token_hash,revoked,expires_at) VALUES(?,?,?,?,?,?)')
      .run(client.id, `Fixture ${client.id}`, client.kind, `hash-${client.id}`, client.id === 'revoked' ? 1 : 0, '2100-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO grants(client_id,connection_id,capabilities,visibility) VALUES(?,?,?,?)')
      .run(client.id, 'connection', '["account.balance"]', client.visibility === null ? null : JSON.stringify(client.visibility));
  }
  db.close();
  return path;
}

function open(path: string) {
  const db = new DbClient(path);
  cleanup.push(() => db.close());
  return db;
}

describe('unified client identity storage', () => {
  it('creates identities without a transport column and persists their explicit authorization', async () => {
    const db = open(':memory:');
    await db.upsertConnector({ id: 'fixture', title: 'Fixture', version: '1', transport: 'http', manifest: {} });
    await db.createConnection({ id: 'connection', connector_id: 'fixture', label: 'Fixture', config: {} });
    const created = await db.createClient({ id: 'client', label: 'Balance window', token_hash: 'fixture-hash', expires_at: '2100-01-01' });
    expect(created).not.toHaveProperty('kind');
    await db.upsertGrant({ client_id: 'client', connection_id: 'connection', capabilities: ['account.balance'], visibility: { pii: false, financial: true, content: false } });
    expect((await db.listClients())[0]).toMatchObject({ id: 'client', label: 'Balance window', expires_at: '2100-01-01' });
    expect((await db.listGrants())[0]?.visibility).toEqual({ pii: false, financial: true, content: false });
    expect((await db.rawQuery('PRAGMA table_info(clients)')).map((column: unknown) => (column as { name: string }).name)).not.toContain('kind');
  });

  it('materializes the previous effective policy before dropping the column and is stable after reopening', async () => {
    const path = legacy([
      { id: 'cli-default', kind: 'cli', visibility: null },
      { id: 'mcp-default', kind: 'mcp', visibility: null },
      { id: 'cron-empty', kind: 'cron', visibility: {} },
      { id: 'cli-denied', kind: 'cli', visibility: { pii: false, financial: false } },
      { id: 'mcp-allowed', kind: 'mcp', visibility: { pii: true, content: false } },
      { id: 'cron-partial', kind: 'cron', visibility: { financial: false } },
      { id: 'revoked', kind: 'cli', visibility: { pii: false, financial: true, content: false } },
      { id: 'admin-default', kind: 'admin', visibility: null },
    ]);
    let db = open(path);
    const expected = {
      'cli-default': { pii: true, financial: true, content: true },
      'mcp-default': { pii: false, financial: true, content: true },
      'cron-empty': { pii: false, financial: true, content: true },
      'cli-denied': { pii: false, financial: false, content: true },
      'mcp-allowed': { pii: true, financial: true, content: false },
      'cron-partial': { pii: false, financial: false, content: true },
      revoked: { pii: false, financial: true, content: false },
      'admin-default': { pii: true, financial: true, content: true },
    };
    const grants = await db.listGrants();
    expect(Object.fromEntries(grants.map((grant) => [grant.client_id, grant.visibility]))).toEqual(expected);
    expect(grants.every((grant) => JSON.stringify(grant.capabilities) === '["account.balance"]')).toBe(true);
    const identities = await db.listClients();
    expect(identities).toHaveLength(8);
    expect(identities.every((client) => !Object.hasOwn(client, 'kind') && client.expires_at === '2100-01-01T00:00:00.000Z' && client.token_hash === `hash-${client.id}`)).toBe(true);
    expect(identities.find((client) => client.id === 'revoked')?.revoked).toBe(true);
    expect(await db.listCredentials('connection')).toHaveLength(1);
    expect(await db.rawQuery('PRAGMA foreign_key_check')).toEqual([]);
    await db.close();
    db = open(path);
    expect(await db.listClients()).toEqual(identities);
    expect(await db.listGrants()).toEqual(grants);
    expect(await db.rawQuery('PRAGMA foreign_key_check')).toEqual([]);
    await db.createClient({ id: 'new-client', label: 'Unified client', token_hash: 'new-hash' });
    await db.upsertGrant({ client_id: 'new-client', connection_id: 'connection', capabilities: [] });
    expect(await db.rawQuery('PRAGMA foreign_key_check')).toEqual([]);
    await db.deleteConnection('connection');
    expect(await db.listGrants()).toEqual([]);
    expect(await db.listCredentials('connection')).toEqual([]);
    expect(await db.listClients()).toHaveLength(9);
  });

  it('refuses the identity migration while a server or maintenance lease is active', async () => {
    const path = legacy([{ id: 'client', kind: 'cli', visibility: null }]);
    const before = new Database(path);
    before.prepare("INSERT INTO og_service_lease(slot,owner,mode,expires_at) VALUES('primary','fixture-owner','server',?)").run(Date.now() + 60_000);
    before.close();
    const db = open(path);
    await expect(db.listClients()).rejects.toThrow('Stop the active server or maintenance process');
    await db.close();
    const raw = new Database(path);
    try {
      expect(raw.prepare('SELECT kind FROM clients').get()).toEqual({ kind: 'cli' });
      expect(raw.prepare('SELECT visibility FROM grants').get()).toEqual({ visibility: null });
      raw.prepare('UPDATE og_service_lease SET expires_at=0').run();
    } finally { raw.close(); }
    const restarted = open(path);
    expect((await restarted.listGrants())[0]?.visibility).toEqual({ pii: true, financial: true, content: true });
  });

  it('rolls back all policies and preserves the old column when a stored policy is malformed', async () => {
    const path = legacy([{ id: 'first', kind: 'cli', visibility: null }, { id: 'second', kind: 'mcp', visibility: null }]);
    const before = new Database(path);
    before.prepare('UPDATE grants SET visibility=? WHERE client_id=?').run('{"pii":"yes"}', 'second');
    before.close();
    const db = open(path);
    await expect(db.listGrants()).rejects.toThrow('Stored client visibility is invalid');
    await db.close();
    const raw = new Database(path);
    try {
      expect(raw.prepare('SELECT kind FROM clients ORDER BY id').all()).toEqual([{ kind: 'cli' }, { kind: 'mcp' }]);
      expect(raw.prepare('SELECT client_id,visibility FROM grants ORDER BY client_id').all()).toEqual([
        { client_id: 'first', visibility: null }, { client_id: 'second', visibility: '{"pii":"yes"}' },
      ]);
      expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { raw.close(); }
  });
});
