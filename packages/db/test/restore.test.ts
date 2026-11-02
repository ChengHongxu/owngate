// Methods the server uses to rebuild its in-memory state at startup:
// listConnections / listClients / listGrants, plus the grant upsert and the
// connection delete that keep the persisted state in step with the admin API.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DbClient } from '../src/client.js';
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DB_PATH = resolve('./test/tmp-restore.db');

function removeDbFiles(): void {
  for (const ext of ['', '-wal', '-shm']) {
    if (existsSync(`${DB_PATH}${ext}`)) rmSync(`${DB_PATH}${ext}`);
  }
}

describe('DbClient state listing for startup restore', () => {
  let db: DbClient;

  beforeAll(async () => {
    removeDbFiles();
    db = new DbClient(DB_PATH);
    await db.upsertConnector({ id: 'ct', version: '1.0.0', title: 'CT', transport: 'http', manifest: {} });
    await db.createConnection({ id: 'conn-a', connector_id: 'ct', label: 'A', config: { base_url: 'https://a.example' } });
    await db.createConnection({
      id: 'conn-b',
      connector_id: 'ct',
      label: 'B',
      config: {},
      capability_states: { 'x.y': { status: 'needs_auth', reason: 'expired' } },
    });
    await db.createClient({ id: 'cl-1', label: 'one', kind: 'cli', token_hash: 'h1' });
    await db.createClient({ id: 'cl-2', label: 'two', kind: 'mcp', token_hash: 'h2' });
    await db.revokeClient('cl-2');
  });

  afterAll(async () => {
    await db.close();
    removeDbFiles();
  });

  it('listConnections returns JSON columns as objects', async () => {
    const rows = await db.listConnections();
    const a = rows.find((r) => r.id === 'conn-a');
    const b = rows.find((r) => r.id === 'conn-b');
    expect(a?.config).toEqual({ base_url: 'https://a.example' });
    // Column default ('{}') must come back as an object too, not as a string.
    expect(a?.capability_states).toEqual({});
    expect(b?.capability_states).toEqual({ 'x.y': { status: 'needs_auth', reason: 'expired' } });
  });

  it('listClients includes revoked clients with token_hash and a boolean flag', async () => {
    const rows = await db.listClients();
    expect(rows.map((r) => r.id).sort()).toEqual(['cl-1', 'cl-2']);
    const revoked = rows.find((r) => r.id === 'cl-2');
    expect(revoked?.revoked).toBe(true);
    expect(revoked?.token_hash).toBe('h2');
    expect(rows.find((r) => r.id === 'cl-1')?.revoked).toBe(false);
  });

  it('upsertGrant replaces the capability list for the same client and connection', async () => {
    await db.upsertGrant({ client_id: 'cl-1', connection_id: 'conn-a', capabilities: ['a.one'] });
    await db.upsertGrant({ client_id: 'cl-1', connection_id: 'conn-a', capabilities: ['a.one', 'a.two'] });
    await db.upsertGrant({ client_id: 'cl-1', connection_id: 'conn-b', capabilities: ['*'] });
    const rows = await db.listGrants();
    expect(rows).toHaveLength(2);
    expect(rows.find((g) => g.connection_id === 'conn-a')?.capabilities).toEqual(['a.one', 'a.two']);
    expect(rows.find((g) => g.connection_id === 'conn-b')?.capabilities).toEqual(['*']);
  });

  it('deleteConnection removes the connection and cascades its grants', async () => {
    const deleted = await db.deleteConnection('conn-b');
    expect(deleted?.id).toBe('conn-b');
    expect((await db.listConnections()).map((r) => r.id)).toEqual(['conn-a']);
    expect((await db.listGrants()).map((g) => g.connection_id)).toEqual(['conn-a']);
    expect(await db.deleteConnection('conn-b')).toBeUndefined();
  });
});
