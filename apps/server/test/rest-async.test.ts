import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbClient } from '@owngate/db';
import { Vault } from '@owngate/vault';
import { ok } from '@owngate/core';
import type { Capability, Client, Connection, InvokeServices } from '@owngate/core';
import { registerRestRoutes } from '../src/routes/rest.js';
import { TaskService } from '../src/tasks/service.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(options: { longRunning?: boolean; granted?: boolean; paused?: boolean; adminOnly?: boolean } = {}) {
  const db = new DbClient(':memory:');
  const app = Fastify();
  const client: Client = { id: 'cli', label: 'Fixture', revoked: false, created_at: '2026-11-03' };
  const connection: Connection = { id: 'conn', connector_id: 'fixture', label: 'Fixture', config: {}, capability_states: {},
    paused: options.paused ?? false, created_at: '2026-11-03', updated_at: '2026-11-03' };
  const capability: Capability = { id: 'echo.long', kind: 'query', effect: 'read', title: 'Echo', description: '', approval: 'never',
    input: { type: 'object', required: ['message'], properties: { message: { type: 'string' } } }, output: { type: 'object' },
    cache: null, long_running: options.longRunning ?? true, cancel: 'none', idempotency: 'none', verify: null,
    transport: 'http', support: { status: 'supported' }, ...(options.adminOnly ? { roles: ['admin' as const] } : {}) };
  const dispatch = vi.fn(async () => ok({ message: 'once' }, { connection_id: connection.id, connection_label: connection.label,
    capability_id: capability.id, support: capability.support }));
  const lookup = vi.fn(() => capability);
  const services: InvokeServices = { connections: { get: () => connection }, capabilities: { get: lookup },
    auth: { getClient: (hash) => hash === 'issued' ? client : undefined, getClientById: (id) => id === client.id ? client : undefined,
      getGrants: () => options.granted === false ? [] : [{ client_id: client.id, connection_id: connection.id, capabilities: ['*'] }] },
    cache: { get: () => undefined, set: () => {}, invalidate: () => {} }, audit: { append: () => {} }, dispatch: { dispatch } };
  const invokeOpts = { hashToken: (value: string) => value, redactOutput: (value: unknown) => value };
  const vault = new Vault('11'.repeat(32));
  const tasks = new TaskService({ db, vault, services, invokeOpts });
  const submit = vi.spyOn(tasks, 'submit');
  cleanup.push(async () => { await app.close(); await tasks.stop(); await db.close(); });
  await registerRestRoutes(app, { services, invokeOpts, tasks });
  const request = (prefer = 'respond-async', token = 'issued', input: unknown = { message: 'hello' }) => app.inject({ method: 'POST', url: '/api/invoke',
    headers: { authorization: `Bearer ${token}`, ...(prefer ? { prefer } : {}) },
    payload: { connection_id: connection.id, capability_id: capability.id, input } });
  return { db, app, connection, capability, request, dispatch, submit, lookup };
}

describe('REST Prefer async negotiation', () => {
  it('durably submits a granted long query once and acknowledges the preference', async () => {
    const { db, request, dispatch, submit } = await fixture();
    const response = await request('wait=1, Respond-Async');
    expect(response.statusCode).toBe(202);
    expect(response.headers['preference-applied']).toBe('respond-async');
    expect(response.json()).toMatchObject({ status: 'pending', task_id: expect.stringMatching(/^tsk_/) });
    expect(await db.rawQuery('SELECT status,input FROM tasks')).toEqual([{ status: 'pending', input: '{}' }]);
    expect(submit).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([{ longRunning: false, prefer: 'respond-async' }, { longRunning: true, prefer: '' }])('retains synchronous invocation for %j', async ({ longRunning, prefer }) => {
    const { request, dispatch, submit } = await fixture({ longRunning });
    const response = await request(prefer);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: 'success', data: { message: 'once' } });
    expect(response.headers['preference-applied']).toBeUndefined();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    { input: null, schema: { type: 'null' } },
    { input: ['one', 'two'], schema: { type: 'array', items: { type: 'string' } } },
    { input: false, schema: { type: 'boolean' } },
  ])('preserves explicit JSON input $input through synchronous dispatch and durable submission', async ({ input, schema }) => {
    const { request, capability, connection, dispatch, submit } = await fixture();
    capability.input = schema;
    const synchronous = await request('', 'issued', input);
    expect(synchronous.statusCode).toBe(200);
    expect(synchronous.json().outcome).toBe('success');
    expect(dispatch).toHaveBeenCalledWith(connection, capability, input);
    dispatch.mockClear();

    const asynchronous = await request('respond-async', 'issued', input);
    expect(asynchronous.statusCode).toBe(202);
    expect(submit).toHaveBeenCalledWith({ connection_id: connection.id, capability_id: capability.id, input }, { kind: 'client', client_id: 'cli' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('defaults an omitted input to an empty object in both invocation modes', async () => {
    const { app, connection, capability, dispatch, submit } = await fixture();
    capability.input = { type: 'object', additionalProperties: false };
    for (const prefer of ['', 'respond-async']) {
      const response = await app.inject({ method: 'POST', url: '/api/invoke',
        headers: { authorization: 'Bearer issued', ...(prefer ? { prefer } : {}) },
        payload: { connection_id: connection.id, capability_id: capability.id } });
      expect(response.statusCode).toBe(prefer ? 202 : 200);
    }
    expect(dispatch).toHaveBeenCalledWith(connection, capability, {});
    expect(submit).toHaveBeenCalledWith({ connection_id: connection.id, capability_id: capability.id, input: {} }, { kind: 'client', client_id: 'cli' });
  });

  it('does not discover a capability for an unknown token', async () => {
    const { request, submit, lookup } = await fixture();
    const response = await request('respond-async', 'unknown');
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
    expect(lookup).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('denies an ungranted query without creating or dispatching work', async () => {
    const { request, submit, dispatch, db } = await fixture({ granted: false });
    const response = await request();
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('PERMISSION_DENIED');
    expect(submit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await db.rawQuery('SELECT id FROM tasks')).toEqual([]);
  });

  it.each([{ paused: true, code: 'CAPABILITY_DISABLED' }, { adminOnly: true, code: 'PERMISSION_DENIED' }])('enforces current queue gates: %j', async ({ code, ...options }) => {
    const { request, db, dispatch } = await fixture(options);
    const response = await request();
    expect(response.json()).toMatchObject({ outcome: 'error', error: { code } });
    expect(response.headers['preference-applied']).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await db.rawQuery('SELECT id FROM tasks')).toEqual([]);
  });

  it('returns the standard validation envelope without falling back to synchronous invocation', async () => {
    const { request, dispatch, submit, db } = await fixture();
    const response = await request('respond-async', 'issued', { message: 123 });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ status: 'error', outcome: 'error', error: { code: 'INVALID_PARAMS' } });
    expect(submit).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await db.rawQuery('SELECT id FROM tasks')).toEqual([]);
  });
});
