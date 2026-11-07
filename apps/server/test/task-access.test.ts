import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DbClient } from '@owngate/db';
import { Vault, vaultContext } from '@owngate/vault';
import type { Capability, Client, Connection, Grant, InvokeServices } from '@owngate/core';
import { registerTaskRoutes } from '../src/routes/tasks.js';
import { TaskService } from '../src/tasks/service.js';

const client: Client = { id: 'client-1', label: 'Fixture', revoked: false, created_at: '2026-11-02' };
const connection: Connection = { id: 'conn-1', connector_id: 'fixture', label: 'Fixture', config: {}, capability_states: {}, created_at: '2026-11-02', updated_at: '2026-11-02' };
const capability: Capability = {
  id: 'account.balance', kind: 'query', title: 'Balance', description: '', effect: 'read', approval: 'never',
  input: { type: 'object' }, output: { type: 'object' }, cache: null, long_running: false,
  cancel: 'none', idempotency: 'none', verify: null, transport: 'http', support: { status: 'supported' },
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });

async function fixture(options: { revoked?: boolean; owner?: string; grants?: string[]; missingConnection?: boolean; missingCapability?: boolean } = {}) {
  const app = Fastify();
  const db = new DbClient(':memory:');
  const vault = new Vault('11'.repeat(32));
  let revoked = false;
  const grant: Grant = { client_id: client.id, connection_id: connection.id, capabilities: options.grants ?? ['*'] };
  const services: InvokeServices = {
    auth: {
      getClient: (hash) => hash === 'valid-token' ? { ...client, revoked } : undefined,
      getClientById: (id) => id === client.id ? { ...client, revoked } : undefined,
      getGrants: () => [grant],
    },
    capabilities: { get: () => options.missingCapability ? undefined : capability },
    connections: { get: () => options.missingConnection ? undefined : connection },
    cache: { get: () => undefined, set: () => {}, invalidate: () => {} },
    audit: { append: () => {} }, dispatch: { dispatch: vi.fn() },
  };
  const invokeOpts = { hashToken: (token: string) => token, redactOutput: (data: unknown) => data };
  const tasks = new TaskService({ db, vault, services, invokeOpts });
  cleanup.push(async () => { await app.close(); await tasks.stop(); await db.close(); });
  await db.rawRun(`INSERT INTO tasks(id,client_id,actor_id,connection_id,capability_id,input_ciphertext,status)
    VALUES('task-1',?,?,?,? ,?,'success')`, [options.owner ?? client.id, options.owner ?? client.id,
    connection.id, capability.id, JSON.stringify(vault.encryptJSON({ private_input: 'fixture' }, vaultContext.task('task-1', 'input')))]);
  // Initialize legacy encryption before spying on the specific task read.
  await tasks.list({ kind: 'admin', user_id: 'admin' });
  revoked = options.revoked ?? false;
  const getTask = vi.spyOn(db, 'rawQuery');
  await registerTaskRoutes(app, { tasks, services, invokeOpts });
  return { app, db, tasks, getTask, services, revoke: () => { revoked = true; } };
}

function get(app: FastifyInstance, token?: string) {
  return app.inject({ method: 'GET', url: '/api/tasks/task-1', ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
}

describe('durable task result access', () => {
  it.each([undefined, 'not-issued'])('rejects missing or unknown token %s before reading tasks', async (token) => {
    const { app, getTask } = await fixture();
    const res = await get(app, token);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
    expect(getTask).not.toHaveBeenCalled();
  });

  it('rejects a revoked client even when it knows the task ID', async () => {
    const { app, getTask } = await fixture({ revoked: true });
    const res = await get(app, 'valid-token');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('CLIENT_REVOKED');
    expect(getTask).not.toHaveBeenCalled();
  });

  it('does not expose another client task', async () => {
    const { app } = await fixture({ owner: 'different-client' });
    const res = await get(app, 'valid-token');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PERMISSION_DENIED');
    expect(res.body).not.toContain('different-client');
    expect(res.body).not.toContain('account.balance');
  });

  it('rechecks revocation after the database read completes', async () => {
    const { app, db, getTask, revoke } = await fixture();
    const read = db.rawQuery.bind(db);
    getTask.mockImplementationOnce(async (...args) => { const rows = await read(...args); revoke(); return rows; });
    const res = await get(app, 'valid-token');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('CLIENT_REVOKED');
  });

  it.each([
    { grants: [] }, { grants: ['other.capability'] }, { missingConnection: true }, { missingCapability: true },
  ])('checks current authorization rather than the task snapshot: %j', async (options) => {
    const { app } = await fixture(options);
    const res = await get(app, 'valid-token');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('GRANT_REVOKED');
    expect(res.body).not.toContain('input');
  });

  it('allows the owner with a current matching grant to read the decrypted public view', async () => {
    const { app } = await fixture({ grants: [capability.id] });
    const res = await get(app, 'valid-token');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'task-1', status: 'success', input: { private_input: 'fixture' }, result: null });
    expect(res.body).not.toContain('ciphertext');
    expect(res.body).not.toContain('lease_owner');
  });

  it('also rechecks current grants when cancelling a task', async () => {
    const { app, db, services } = await fixture();
    await db.rawRun("UPDATE tasks SET status='pending' WHERE id='task-1'");
    services.auth.getGrants = () => [];
    const res = await app.inject({ method: 'POST', url: '/api/tasks/task-1/cancel', headers: { authorization: 'Bearer valid-token' } });
    expect(res.statusCode).toBe(403);
    const rows = await db.rawQuery("SELECT status FROM tasks WHERE id='task-1'");
    expect(rows).toEqual([{ status: 'pending' }]);
  });
});
