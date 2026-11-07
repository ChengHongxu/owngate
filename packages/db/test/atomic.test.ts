import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DbClient } from '../src/client.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function memory() {
  const db = new DbClient(':memory:');
  cleanup.push(() => db.close());
  return db;
}

describe('trusted atomic SQL and additive task migrations', () => {
  it('rolls every mutation back when any statement fails', async () => {
    const db = memory();
    await expect(db.rawTransaction([
      { sql: "INSERT INTO tasks(id,client_id,connection_id,capability_id,status) VALUES('rollback','client','conn','read','pending')" },
      { sql: 'INSERT INTO does_not_exist(id) VALUES(1)' },
    ])).rejects.toThrow();
    expect(await db.rawQuery("SELECT id FROM tasks WHERE id='rollback'")).toEqual([]);
  });

  it('supports RETURNING/select results inside the same write transaction', async () => {
    const db = memory();
    const result = await db.rawTransaction([
      { sql: "INSERT INTO tasks(id,client_id,connection_id,capability_id,status) VALUES('one','client','conn','read','pending') RETURNING id", mode: 'all' },
      { sql: 'SELECT status FROM tasks WHERE id=?', params: ['one'], mode: 'get' },
      { sql: "UPDATE tasks SET status='running' WHERE id=?", params: ['one'] },
    ]);
    expect(result[0]).toEqual([{ id: 'one' }]);
    expect(result[1]).toEqual({ status: 'pending' });
    expect(result[2]).toMatchObject({ changes: 1 });
    expect(await db.rawRun("UPDATE tasks SET status='success' WHERE id=?", ['one'])).toMatchObject({ changes: 1 });
  });

  it('upgrades an existing database in place and can reopen it repeatedly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owngate-task-migration-'));
    const path = join(dir, 'existing.db');
    const old = new Database(path);
    // migrate.sql is the original CREATE IF NOT EXISTS schema. The worker's
    // additive migration must supply the new columns for these existing tables.
    old.exec(readFileSync(new URL('../src/migrate.sql', import.meta.url), 'utf8'));
    old.prepare("INSERT INTO connectors(id,version,title,transport) VALUES('test','1','Test','http')").run();
    old.prepare("INSERT INTO connections(id,connector_id,label) VALUES('conn','test','Existing')").run();
    old.prepare("INSERT INTO tasks(id,client_id,connection_id,capability_id,input,status) VALUES('old','client','conn','read','{\"keep\":true}','success')").run();
    old.close();
    let db = new DbClient(path);
    cleanup.push(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });
    expect((await db.listConnections())[0]).toMatchObject({ id: 'conn', paused: false, scope: 'personal', tags: [] });
    expect(await db.rawQuery("SELECT id,status,input,attempts,safe_retry FROM tasks WHERE id='old'"))
      .toEqual([{ id: 'old', status: 'success', input: '{"keep":true}', attempts: 0, safe_retry: 0 }]);
    await db.close();
    db = new DbClient(path);
    expect(await db.rawQuery('SELECT count(*) AS count FROM tasks')).toEqual([{ count: 1 }]);
    expect(await db.rawQuery('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }]);
  });

  it('rejects calls after closing a worker rather than leaving a pending request forever', async () => {
    const db = memory();
    await db.rawQuery('SELECT 1');
    await db.close();
    await expect(db.rawRun('SELECT 1')).rejects.toThrow('closed');
  });
});
