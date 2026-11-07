import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { DbClient } from '@owngate/db';
import { Vault } from '@owngate/vault';
import { err, fail, ok } from '@owngate/core';
import type { Capability, Client, Connection, Grant, InvokeServices, ResultEnvelope, Dispatcher } from '@owngate/core';
import { TaskService } from '../src/tasks/service.js';
import type { TaskServiceDeps, TaskView } from '../src/tasks/service.js';
import { registerTaskRoutes } from '../src/routes/tasks.js';
import { dispatchBrowser } from '../src/dispatchers/browser.js';
import type { BrowserClient } from '../src/browser-client.js';

const CLIENT: Client = { id: 'cl-1', label: 'Test', revoked: false, created_at: '2026-11-02' };
const CONN: Connection = { id: 'co-1', connector_id: 'fixture', label: 'Test site', config: {}, capability_states: {}, created_at: '2026-11-02', updated_at: '2026-11-02' };
const CAP: Capability = { id: 'test.read', title: 'Read', description: '', kind: 'query', effect: 'read', approval: 'never',
  input: { type: 'object', properties: { message: { type: 'string' } }, additionalProperties: false },
  output: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] }, cache: null,
  long_running: true, cancel: 'none', idempotency: 'none', verify: null, transport: 'http', support: { status: 'supported' } };
const SOURCE = { connection_id: CONN.id, connection_label: CONN.label, capability_id: CAP.id, support: CAP.support };
const CALLER = { kind: 'client' as const, client_id: CLIENT.id };
const ADMIN = { kind: 'admin' as const, user_id: 'admin-1' };
const REQUEST = { connection_id: CONN.id, capability_id: CAP.id, input: {} };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(options: Partial<Omit<TaskServiceDeps, 'db' | 'vault' | 'services' | 'invokeOpts'>> = {}) {
  const db = new DbClient(':memory:');
  const vault = new Vault('22'.repeat(32));
  let client = { ...CLIENT };
  let connection = { ...CONN };
  let capability = { ...CAP };
  let grants: Grant[] = [{ client_id: client.id, connection_id: connection.id, capabilities: ['*'] }];
  const dispatch = vi.fn<Dispatcher['dispatch']>(async () => ok({ value: 42 }, SOURCE));
  const services: InvokeServices = {
    auth: { getClient: (hash) => hash === 'valid' ? client : undefined, getClientById: (id) => id === client.id ? client : undefined, getGrants: () => grants },
    capabilities: { get: () => capability }, connections: { get: () => connection },
    cache: { get: () => undefined, set: () => {}, invalidate: () => {} }, audit: { append: () => {} }, dispatch: { dispatch },
  };
  const invokeOpts = { hashToken: (value: string) => value, redactOutput: (value: unknown) => value };
  const deps = { db, vault, services, invokeOpts, pollIntervalMs: 10, retryDelayMs: 1, ...options };
  const tasks = new TaskService(deps);
  cleanup.push(async () => { await tasks.stop(); await db.close(); });
  return { db, vault, tasks, services, deps, dispatch, setClient: (value: Partial<Client>) => { client = { ...client, ...value }; },
    setConnection: (value: Partial<Connection>) => { connection = { ...connection, ...value }; },
    setCapability: (value: Partial<Capability>) => { capability = { ...capability, ...value }; }, clearGrants: () => { grants = []; } };
}
async function terminal(tasks: TaskService, id: string): Promise<TaskView> {
  await expect.poll(async () => (await tasks.get(id, ADMIN)).status, { timeout: 2500, interval: 10 }).not.toMatch(/^(pending|running)$/);
  return tasks.get(id, ADMIN);
}

describe('durable task queue', () => {
  it('persists accepted input and events before responding and encrypts both input and result', async () => {
    const { tasks, db } = await fixture();
    const submitted = await tasks.submit({ ...REQUEST, input: { message: 'private-request-value' } }, CALLER);
    expect(submitted.status).toBe('pending');
    const [stored] = await db.rawQuery('SELECT * FROM tasks WHERE id=?', [submitted.task_id]) as Array<Record<string, unknown>>;
    expect(stored?.['input']).toBe('{}');
    expect(stored?.['input_ciphertext']).toBeTypeOf('string');
    expect(JSON.stringify(stored)).not.toContain('private-request-value');
    expect(await tasks.events(submitted.task_id, CALLER)).toMatchObject([{ event: 'created' }]);
    await tasks.start();
    expect(await terminal(tasks, submitted.task_id)).toMatchObject({ status: 'success', result: { data: { value: 42 } }, input: { message: 'private-request-value' } });
    const rows = await db.rawQuery('SELECT input,result_ciphertext FROM tasks WHERE id=?', [submitted.task_id]);
    expect(JSON.stringify(rows)).not.toContain('"value":42');
    expect(JSON.stringify(await tasks.events(submitted.task_id, CALLER))).not.toContain('private-request-value');
  });

  it('continues after the HTTP submission has returned and exposes events independently', async () => {
    const { tasks, services, deps, dispatch } = await fixture();
    const app = Fastify();
    cleanup.push(() => app.close());
    await registerTaskRoutes(app, { tasks, services, invokeOpts: deps.invokeOpts });
    const response = await app.inject({ method: 'POST', url: '/api/tasks', headers: { authorization: 'Bearer valid' }, payload: REQUEST });
    expect(response.statusCode).toBe(202);
    expect(dispatch).not.toHaveBeenCalled();
    const id = response.json().task_id as string;
    await tasks.start();
    expect((await terminal(tasks, id)).status).toBe('success');
    const events = await app.inject({ method: 'GET', url: `/api/tasks/${id}/events`, headers: { authorization: 'Bearer valid' } });
    expect(events.json().events.map((event: { event: string }) => event.event)).toEqual(['created', 'started', 'finished']);
  });

  it('atomically claims one task across two competing workers', async () => {
    const { tasks, deps, dispatch } = await fixture();
    const second = new TaskService(deps);
    cleanup.push(() => second.stop());
    const { task_id: id } = await tasks.submit(REQUEST, CALLER);
    await Promise.all([tasks.start(), second.start()]);
    expect(await terminal(tasks, id)).toMatchObject({ status: 'success', attempts: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await tasks.events(id, CALLER)).filter((event) => event.event === 'started')).toHaveLength(1);
  });

  it('heartbeats keep a live read from being recovered by a second worker', async () => {
    const { tasks, db, deps, dispatch } = await fixture({ leaseMs: 150, heartbeatMs: 30 });
    const blocked = deferred<ResultEnvelope>();
    dispatch.mockImplementation(() => blocked.promise);
    const { task_id: id } = await tasks.submit(REQUEST, CALLER);
    await tasks.start();
    await expect.poll(() => dispatch.mock.calls.length).toBe(1);
    const initial = await db.rawQuery('SELECT lease_expires_at FROM tasks WHERE id=?', [id]);
    await expect.poll(() => db.rawQuery('SELECT lease_expires_at FROM tasks WHERE id=?', [id]), { interval: 25 }).not.toEqual(initial);
    const second = new TaskService(deps);
    cleanup.push(() => second.stop());
    await second.start();
    blocked.resolve(ok({ value: 99 }, SOURCE));
    expect(await terminal(tasks, id)).toMatchObject({ status: 'success', attempts: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await tasks.events(id, CALLER)).some((event) => event.event === 'recovered')).toBe(false);
  });

  it('recovers an expired read lease and retries it through invoke', async () => {
    const { tasks, db, dispatch } = await fixture();
    const { task_id: id } = await tasks.submit(REQUEST, CALLER);
    await db.rawRun("UPDATE tasks SET status='running',attempts=1,lease_owner='dead',lease_expires_at='2000-01-01' WHERE id=?", [id]);
    await tasks.start();
    expect(await terminal(tasks, id)).toMatchObject({ status: 'success', attempts: 2 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await tasks.events(id, CALLER)).some((event) => event.event === 'recovered')).toBe(true);
  });

  it.each(['unsafe', 'changed-capability', 'exhausted'] as const)('does not replay an expired %s task', async (kind) => {
    const { tasks, db, dispatch, setCapability } = await fixture();
    const { task_id: id } = await tasks.submit(REQUEST, CALLER);
    await db.rawRun("UPDATE tasks SET status='running',attempts=?,safe_retry=?,lease_owner='dead',lease_expires_at='2000-01-01' WHERE id=?",
      [kind === 'exhausted' ? 3 : 1, kind === 'unsafe' ? 0 : 1, id]);
    if (kind === 'changed-capability') setCapability({ kind: 'action', effect: 'write' });
    await tasks.start();
    expect(await terminal(tasks, id)).toMatchObject({ status: 'unknown_outcome', result: { error: { code: 'OUTCOME_UNKNOWN' } } });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('retries only retryable read errors, with a bounded persisted attempt count', async () => {
    const { tasks, dispatch } = await fixture();
    dispatch.mockResolvedValueOnce(fail(err('UPSTREAM_UNAVAILABLE', 'Temporary failure'), SOURCE));
    const { task_id: id } = await tasks.submit(REQUEST, CALLER);
    await tasks.start();
    expect(await terminal(tasks, id)).toMatchObject({ status: 'success', attempts: 2 });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((await tasks.events(id, CALLER)).some((event) => event.event === 'retry_scheduled')).toBe(true);
  });

  it('does not retry a non-retryable parse failure', async () => {
    const { tasks, dispatch } = await fixture();
    dispatch.mockResolvedValue(fail(err('PARSE_FAILED', 'Changed response'), SOURCE));
    const { task_id: id } = await tasks.submit(REQUEST, CALLER);
    await tasks.start();
    expect(await terminal(tasks, id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not resubmit a browser query rejected by the worker account cooldown', async () => {
    const { tasks, dispatch, setConnection, setCapability } = await fixture();
    setConnection({ connector_id: 'bilibili' });
    setCapability({ transport: 'browser' });
    const check = vi.fn<BrowserClient['check']>().mockResolvedValue({ status: 'error', error: {
      code: 'RATE_LIMITED', what_happened: 'Account query cooldown',
      next_step: 'Wait before querying this account again', retryable: false,
    } });
    const browser = { check } as unknown as BrowserClient;
    dispatch.mockImplementation((connection, capability, input) => dispatchBrowser(browser, connection, capability, input));
    const { task_id: id } = await tasks.submit(REQUEST, CALLER);
    await tasks.start();
    expect(await terminal(tasks, id)).toMatchObject({ status: 'failed', attempts: 1,
      result: { error: { code: 'RATE_LIMITED', retryable: false } } });
    expect(check).toHaveBeenCalledTimes(1);
    expect((await tasks.events(id, CALLER)).some(event => event.event === 'retry_scheduled')).toBe(false);
  });

  it('checks client revocation at execution time and never stores the raw token', async () => {
    const { tasks, db, setClient, dispatch } = await fixture();
    const { task_id: id } = await tasks.submit(REQUEST, CALLER);
    setClient({ revoked: true });
    await tasks.start();
    expect(await terminal(tasks, id)).toMatchObject({ status: 'failed', result: { error: { code: 'CLIENT_REVOKED' } } });
    expect(dispatch).not.toHaveBeenCalled();
    await expect(tasks.get(id, CALLER)).rejects.toMatchObject({ statusCode: 401 });
    expect(JSON.stringify(await db.rawQuery('SELECT * FROM tasks'))).not.toContain('Bearer');
  });

  it('withholds output when grants are revoked while an upstream read is running', async () => {
    const { tasks, dispatch, clearGrants } = await fixture();
    const blocked = deferred<ResultEnvelope>();
    dispatch.mockImplementation(() => blocked.promise);
    const { task_id: id } = await tasks.submit(REQUEST, CALLER);
    await tasks.start();
    await expect.poll(() => dispatch.mock.calls.length).toBe(1);
    clearGrants();
    blocked.resolve(ok({ value: 314159 }, SOURCE));
    expect(await terminal(tasks, id)).toMatchObject({ status: 'failed', result: { data: null, error: { code: 'PERMISSION_DENIED' } } });
    await expect(tasks.get(id, CALLER)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('cancels a queued task before it is sent', async () => {
    const { tasks, dispatch } = await fixture();
    const { task_id: id } = await tasks.submit(REQUEST, CALLER);
    expect(await tasks.cancel(id, CALLER)).toMatchObject({ status: 'cancelled', cancellation: {
      state: 'cancelled_before_send', remote_confirmed: false, may_continue_remote: false } });
    await tasks.start();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('reports running cancellation as local and prevents a late result overwriting it', async () => {
    const { tasks, dispatch } = await fixture();
    const blocked = deferred<ResultEnvelope>();
    dispatch.mockImplementation(() => blocked.promise);
    const { task_id: id } = await tasks.submit(REQUEST, CALLER);
    await tasks.start();
    await expect.poll(() => dispatch.mock.calls.length).toBe(1);
    const cancelled = await tasks.cancel(id, CALLER);
    expect(cancelled).toMatchObject({ status: 'cancelled', result: null, cancellation: {
      state: 'cancelled_local', remote_confirmed: false, may_continue_remote: true } });
    blocked.resolve(ok({ value: 999 }, SOURCE));
    await expect.poll(() => tasks.get(id, CALLER)).toMatchObject({ status: 'cancelled', result: null });
    expect(JSON.stringify(await tasks.events(id, CALLER))).not.toContain('remote_cancelled');
  });

  it('uses the atomic cancellation status when a worker wins the claim race', async () => {
    const { tasks, db } = await fixture();
    const { task_id: id } = await tasks.submit(REQUEST, CALLER);
    const write = db.rawTransaction.bind(db);
    vi.spyOn(db, 'rawTransaction').mockImplementationOnce(async (queries) => {
      await db.rawRun("UPDATE tasks SET status='running' WHERE id=?", [id]);
      return write(queries);
    });
    expect(await tasks.cancel(id, CALLER)).toMatchObject({ cancellation: {
      state: 'cancelled_local', may_continue_remote: true, remote_confirmed: false } });
  });

  it('fences a stale completion after another worker acquired its lease', async () => {
    const { tasks, db, dispatch } = await fixture();
    const blocked = deferred<ResultEnvelope>();
    dispatch.mockImplementation(() => blocked.promise);
    const { task_id: id } = await tasks.submit(REQUEST, CALLER);
    await tasks.start();
    await expect.poll(() => dispatch.mock.calls.length).toBe(1);
    await db.rawRun("UPDATE tasks SET lease_owner='replacement', lease_expires_at='2100-01-01' WHERE id=?", [id]);
    blocked.resolve(ok({ value: 100 }, SOURCE));
    await expect.poll(() => db.rawQuery('SELECT lease_owner,status,result_ciphertext FROM tasks WHERE id=?', [id])).toEqual([
      { lease_owner: 'replacement', status: 'running', result_ciphertext: null },
    ]);
  });

  it('supports authenticated admin tasks without a client grant and checks admin existence again at execution', async () => {
    let adminActive = true;
    const { tasks, db, dispatch, clearGrants } = await fixture({ isAdminActive: () => adminActive });
    clearGrants();
    const first = await tasks.submit(REQUEST, ADMIN);
    await tasks.start();
    expect(await terminal(tasks, first.task_id)).toMatchObject({ actor_kind: 'admin', status: 'success' });
    const second = await tasks.submit(REQUEST, ADMIN);
    adminActive = false;
    await expect.poll(async () => (await db.rawQuery('SELECT status FROM tasks WHERE id=?', [second.task_id]))[0], { interval: 10 }).toEqual({ status: 'failed' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('prevents request bodies from choosing an admin or a different client identity', async () => {
    const { tasks, services, deps } = await fixture();
    const app = Fastify();
    cleanup.push(() => app.close());
    await registerTaskRoutes(app, { tasks, services, invokeOpts: deps.invokeOpts });
    const denied = await app.inject({ method: 'POST', url: '/api/tasks', payload: { ...REQUEST, caller: ADMIN, token: 'valid' } });
    expect(denied.statusCode).toBe(401);
    const response = await app.inject({ method: 'POST', url: '/api/tasks', headers: { authorization: 'Bearer valid' }, payload: { ...REQUEST, caller: ADMIN, client_id: 'other-client' } });
    expect(response.statusCode).toBe(202);
    expect(await tasks.get(response.json().task_id as string, CALLER)).toMatchObject({ actor_kind: 'client', actor_id: CALLER.client_id });
  });

  it('rejects new paused calls and stops queued tasks through the invocation gate', async () => {
    const { tasks, setConnection, dispatch } = await fixture();
    const { task_id: id } = await tasks.submit(REQUEST, CALLER);
    setConnection({ paused: true });
    await expect(tasks.submit(REQUEST, CALLER)).rejects.toMatchObject({ statusCode: 409 });
    await tasks.start();
    expect(await terminal(tasks, id)).toMatchObject({ status: 'failed', result: { error: { code: 'CAPABILITY_DISABLED' } } });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('encrypts an old plaintext input in place without replaying its historical status', async () => {
    const { tasks, db, dispatch } = await fixture();
    await db.rawRun(`INSERT INTO tasks(id,client_id,connection_id,capability_id,input,status) VALUES('legacy',?,?,?,?,'success')`,
      [CLIENT.id, CONN.id, CAP.id, JSON.stringify({ message: 'legacy-private-input' })]);
    expect(await tasks.get('legacy', CALLER)).toMatchObject({ status: 'success', input: { message: 'legacy-private-input' } });
    const rows = await db.rawQuery("SELECT input,input_ciphertext FROM tasks WHERE id='legacy'");
    expect(JSON.stringify(rows)).not.toContain('legacy-private-input');
    expect((rows[0] as { input: string }).input).toBe('{}');
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('task results apply the current client policy', () => {
  it('retains an encrypted authorized result and re-filters every read when visibility changes', async () => {
    const { tasks, services, deps } = await fixture();
    let financial = false;
    services.auth.getGrants = () => [{ client_id: CLIENT.id, connection_id: CONN.id, capabilities: ['*'], visibility: { financial } }];
    Object.assign(deps.invokeOpts, { redactOutput: (value: unknown, _capability: Capability, audience: 'admin' | 'client', _client?: Client, grant?: Grant) => ({
      ...(value as Record<string, unknown>), value: audience === 'admin' || grant?.visibility?.financial ? (value as { value: number }).value : null,
    }) });
    const { task_id: id } = await tasks.submit(REQUEST, CALLER);
    await tasks.start();
    await terminal(tasks, id);
    const hidden = await tasks.get(id, CALLER);
    expect(hidden.result?.data).toEqual({ value: null });
    expect(hidden.result?.fields['value']?.status).toBe('redacted');
    financial = true;
    expect((await tasks.get(id, CALLER)).result?.data).toEqual({ value: 42 });
    expect((await tasks.get(id, CALLER)).result?.fields['value']).toBeUndefined();
  });

  it('denies historical result, event and cancel access once the current client expires', async () => {
    const { tasks, setClient } = await fixture();
    const { task_id: id } = await tasks.submit(REQUEST, CALLER);
    setClient({ expires_at: '2000-01-01' });
    await expect(tasks.get(id, CALLER)).rejects.toMatchObject({ statusCode: 401, error: { code: 'UNAUTHENTICATED' } });
    await expect(tasks.events(id, CALLER)).rejects.toMatchObject({ statusCode: 401 });
    await expect(tasks.cancel(id, CALLER)).rejects.toMatchObject({ statusCode: 401 });
    await expect(tasks.submit(REQUEST, CALLER)).rejects.toMatchObject({ statusCode: 401 });
  });
});
