import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DbClient } from '../src/client.js';
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DB_PATH = resolve('./test/tmp-worker.db');

beforeAll(() => {
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
  if (existsSync(`${DB_PATH}-wal`)) rmSync(`${DB_PATH}-wal`);
  if (existsSync(`${DB_PATH}-shm`)) rmSync(`${DB_PATH}-shm`);
});

afterAll(async () => {
  // worker will clean up on terminate
});

describe('DbClient worker_thread round-trip', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = new DbClient(DB_PATH);
    // give worker a moment to open
    await new Promise(r => setTimeout(r, 200));
  });

  afterAll(async () => {
    await db.close();
    for (const ext of ['', '-wal', '-shm']) {
      if (existsSync(`${DB_PATH}${ext}`)) rmSync(`${DB_PATH}${ext}`);
    }
  });

  it('creates a connector via upsertConnector', async () => {
    const result = await db.upsertConnector({
      id: 'test-conn-type',
      version: '1.0.0',
      title: 'Test Connector',
      transport: 'http',
      manifest: { foo: 'bar' },
    });
    expect(result).toBeDefined();
  });

  it('lists connectors', async () => {
    const list = await db.listConnectors();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]).toHaveProperty('id', 'test-conn-type');
  });

  it('creates and retrieves a connection', async () => {
    await db.createConnection({
      id: 'conn-1',
      connector_id: 'test-conn-type',
      label: 'My Test Site',
      config: { base_url: 'https://example.com' },
    });
    const conn = await db.getConnection('conn-1');
    expect(conn).toBeDefined();
    expect((conn as { label: string }).label).toBe('My Test Site');
  });

  it('lists connections', async () => {
    const list = await db.listConnections();
    expect(list.length).toBe(1);
  });

  it('creates and revokes a client', async () => {
    await db.createClient({
      id: 'client-1',
      label: 'Test Client',
      kind: 'cli',
      token_hash: 'hash-123',
    });
    const found = await db.getClientByToken('hash-123');
    expect(found).toBeDefined();
    expect((found as { revoked: boolean }).revoked).toBe(false);

    await db.revokeClient('client-1');
    const after = await db.getClientByToken('hash-123');
    expect(after).toBeUndefined(); // revoked clients are filtered out
  });

  it('creates and updates a task', async () => {
    await db.createTask({
      id: 'task-1',
      client_id: 'client-1',
      connection_id: 'conn-1',
      capability_id: 'account.balance',
      input: { foo: 'bar' },
      status: 'pending',
    });
    await db.updateTaskStatus('task-1', 'running', new Date().toISOString());
    const task = await db.getTask('task-1');
    expect(task).toBeDefined();
    expect((task as { status: string }).status).toBe('running');
  });

  it('sets and gets a cache entry', async () => {
    await db.setCacheEntry({
      key: 'cache-1',
      ciphertext: 'enc-data',
      iv: 'iv-val',
      auth_tag: 'tag-val',
      expires_at: new Date(Date.now() + 60000).toISOString(),
    });
    const entry = await db.getCacheEntry('cache-1');
    expect(entry).toBeDefined();
    expect((entry as { key: string }).key).toBe('cache-1');
  });

  it('appends to audit log and reads last entry', async () => {
    await db.appendAuditLog({
      action: 'test.action',
      client_id: 'client-1',
      target: 'conn-1',
      detail: { note: 'test' },
      prev_hash: '0',
      entry_hash: 'hash-1',
    });
    const last = await db.getLastAuditEntry();
    expect(last).toBeDefined();
    expect((last as { action: string }).action).toBe('test.action');
  });
});
