import { afterEach, describe, expect, it, vi } from 'vitest';
import { err, fail, ok, type Capability, type Connection, type Dispatcher, type ErrorCode, type InvocationResultContext, type ResultEnvelope, type SupportState } from '@owngate/core';
import { DbClient } from '@owngate/db';
import { ConnectionVerifier } from '../src/verification.js';
import { buildServer } from '../src/main.js';
import { ProbeScheduler } from '../src/probe/scheduler.js';
import { adminWithStepUp, tempDbPath } from './helpers/admin.js';

const AUTH = 'account.auth';
const FIRST = 'account.first';
const SECOND = 'account.second';
const REVISION = '2026-01-01T00:00:00.000Z';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function capability(id: string, support: SupportState = { status: 'unverified' }): Capability {
  return { id, kind: 'query', title: id, description: id, effect: 'read', approval: 'never',
    input: { type: 'object', properties: { fail: { type: 'boolean' } }, additionalProperties: false },
    output: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
    cache: null, long_running: false, cancel: 'none', idempotency: 'none', verify: null, transport: 'http', support };
}

async function fixture(states: Record<string, SupportState> = {}) {
  const temp = tempDbPath('owngate-status-');
  cleanup.push(async () => temp.cleanup());
  const db = new DbClient(temp.path);
  cleanup.push(() => db.close());
  const capabilities = [capability(AUTH), capability(FIRST), capability(SECOND),
    capability('disabled', { status: 'disabled' }), capability('unsupported', { status: 'unsupported' })];
  await db.upsertConnector({ id: 'fixture', version: '1', title: 'Fixture', transport: 'http', manifest: {} });
  await db.createConnection({ id: 'connection', connector_id: 'fixture', label: 'Fixture', config: {}, capability_states: states });
  await db.updateConnectionStates('connection', states, REVISION);
  const connection: Connection = { id: 'connection', connector_id: 'fixture', label: 'Fixture', config: {}, capability_states: states, created_at: REVISION, updated_at: REVISION };
  let current: Connection | undefined = connection;
  const invoke = vi.fn(async (): Promise<ResultEnvelope> => { throw new Error('run did not need a query'); });
  const verifier = new ConnectionVerifier({ db, getConnection: () => current,
    getCapability: (_id, id) => capabilities.find(cap => cap.id === id), listCapabilities: () => capabilities,
    getPlan: () => ({ browser: false, verification: { capabilities: [AUTH], auth: AUTH } }), invoke });
  let sequence = 0;
  const context = (id: string, verification = false, executionSequence = ++sequence): InvocationResultContext => ({
    connection, capability: capabilities.find(cap => cap.id === id)!, revision: connection.updated_at, verification, sequence: executionSequence,
  });
  const result = (id: string, code?: ErrorCode) => {
    const source = { connection_id: connection.id, connection_label: connection.label, capability_id: id, support: connection.capability_states[id] ?? { status: 'unverified' as const } };
    return code ? fail(err(code, 'Fixture query failed'), source) : ok({ value: 1 }, source);
  };
  const persisted = async () => (await db.rawQuery('SELECT capability_states FROM connections WHERE id=?', [connection.id]))[0] as { capability_states: string };
  return { connection, db, verifier, context, result, persisted, invoke, remove: () => { current = undefined; } };
}

describe('guarded connection observations', () => {
  it('auth success leaves untested queries unverified and preserves real adapter failures and disabled capabilities', async () => {
    const f = await fixture({ [AUTH]: { status: 'needs_auth' }, [FIRST]: { status: 'needs_auth' }, [SECOND]: { status: 'needs_adapter' },
      disabled: { status: 'disabled' }, unsupported: { status: 'unsupported' },
      'failed.adapter': { status: 'needs_adapter', probed_at: REVISION, reason: 'A real adapter failure' } });
    await f.verifier.observe(f.result(AUTH), f.context(AUTH, true));
    expect(f.connection.capability_states[AUTH]?.status).toBe('supported');
    expect(f.connection.capability_states[FIRST]).toEqual({ status: 'unverified' });
    expect(f.connection.capability_states[SECOND]).toEqual({ status: 'unverified' });
    expect(f.connection.capability_states['disabled']).toEqual({ status: 'disabled' });
    expect(f.connection.capability_states['unsupported']).toEqual({ status: 'unsupported' });
    expect(f.connection.capability_states['failed.adapter']?.reason).toBe('A real adapter failure');
    expect(f.connection.updated_at).toBe(REVISION);
    expect(JSON.parse((await f.persisted()).capability_states)).toEqual(f.connection.capability_states);
  });

  it('a successful public capability cannot establish authentication for the account', async () => {
    const f = await fixture({ [AUTH]: { status: 'needs_auth' }, [SECOND]: { status: 'needs_auth' } });
    await f.verifier.observe(f.result(FIRST), f.context(FIRST));
    expect(f.connection.capability_states[FIRST]?.status).toBe('supported');
    expect(f.connection.capability_states[AUTH]?.status).toBe('needs_auth');
    expect(f.connection.capability_states[SECOND]?.status).toBe('needs_auth');
  });

  it('one capability auth failure does not overwrite an already verified auth check or other capabilities', async () => {
    const f = await fixture({ [AUTH]: { status: 'supported', probed_at: REVISION }, [SECOND]: { status: 'supported', probed_at: REVISION } });
    await f.verifier.observe(f.result(FIRST, 'AUTH_REJECTED'), f.context(FIRST));
    expect(f.connection.capability_states[FIRST]?.status).toBe('needs_auth');
    expect(f.connection.capability_states[AUTH]?.status).toBe('supported');
    expect(f.connection.capability_states[SECOND]?.status).toBe('supported');
  });

  it('failure of the declared auth check blocks eligible queries, preserving unsupported and disabled capabilities', async () => {
    const f = await fixture({ disabled: { status: 'disabled' }, unsupported: { status: 'unsupported' }, [FIRST]: { status: 'supported' } });
    await f.verifier.observe(f.result(AUTH, 'AUTH_EXPIRED'), f.context(AUTH));
    expect(f.connection.capability_states[AUTH]?.status).toBe('needs_auth');
    expect(f.connection.capability_states[FIRST]?.status).toBe('needs_auth');
    expect(f.connection.capability_states[SECOND]?.status).toBe('needs_auth');
    expect(f.connection.capability_states['disabled']?.status).toBe('disabled');
    expect(f.connection.capability_states['unsupported']?.status).toBe('unsupported');
  });

  it.each([
    ['UPSTREAM_TIMEOUT', 'unavailable'], ['RATE_LIMITED', 'unavailable'], ['BROWSER_UNAVAILABLE', 'unavailable'],
    ['PARSE_FAILED', 'needs_adapter'], ['CAPABILITY_UNSUPPORTED', 'needs_adapter'], ['PLAN_INSUFFICIENT', 'needs_plan'],
  ] as const)('classifies %s as %s without changing another capability', async (code, status) => {
    const f = await fixture({ [SECOND]: { status: 'supported' } });
    await f.verifier.observe(f.result(FIRST, code), f.context(FIRST));
    expect(f.connection.capability_states[FIRST]?.status).toBe(status);
    expect(f.connection.capability_states[SECOND]?.status).toBe('supported');
  });

  it.each(['INVALID_PARAMS', 'PERMISSION_DENIED', 'CAPABILITY_DISABLED', 'GRANT_REVOKED'] as const)('does not treat request failure %s as a capability failure', async code => {
    const f = await fixture({ [FIRST]: { status: 'supported', probed_at: REVISION } });
    expect(await f.verifier.observe(f.result(FIRST, code), f.context(FIRST))).toBeUndefined();
    expect(f.connection.capability_states[FIRST]).toEqual({ status: 'supported', probed_at: REVISION });
  });

  it('ignores a stale response after a settings change or connection deletion', async () => {
    const f = await fixture({ [FIRST]: { status: 'unverified' } });
    const old = f.context(FIRST);
    f.connection.updated_at = '2026-02-01T00:00:00.000Z';
    expect(await f.verifier.observe(f.result(FIRST, 'AUTH_EXPIRED'), old)).toBeUndefined();
    f.remove();
    expect(await f.verifier.observe(f.result(FIRST), f.context(FIRST))).toBeUndefined();
    expect(f.connection.capability_states[FIRST]?.status).toBe('unverified');
  });

  it('merges concurrent first observations of different capabilities without advancing the settings revision', async () => {
    const f = await fixture({ [FIRST]: { status: 'unverified' }, [SECOND]: { status: 'unverified' } });
    await Promise.all([f.verifier.observe(f.result(FIRST), f.context(FIRST)), f.verifier.observe(f.result(SECOND), f.context(SECOND))]);
    expect(f.connection.capability_states[FIRST]?.status).toBe('supported');
    expect(f.connection.capability_states[SECOND]?.status).toBe('supported');
    expect(f.connection.updated_at).toBe(REVISION);
    expect(JSON.parse((await f.persisted()).capability_states)).toEqual(f.connection.capability_states);
  });

  it('preserves newer execution evidence when an earlier success reaches the observer late', async () => {
    const f = await fixture();
    await f.verifier.observe(f.result(FIRST, 'UPSTREAM_TIMEOUT'), f.context(FIRST, false, 2));
    await f.verifier.observe(f.result(FIRST), f.context(FIRST, false, 1));
    expect(f.connection.capability_states[FIRST]?.status).toBe('unavailable');
  });

  it.each(['needs_auth', 'unverified'] as const)('does not reintroduce an old auth failure after account auth success when the query was %s', async initial => {
    const f = await fixture({ [FIRST]: { status: initial } });
    await f.verifier.observe(f.result(AUTH), f.context(AUTH, false, 3));
    await f.verifier.observe(f.result(FIRST, 'AUTH_EXPIRED'), f.context(FIRST, false, 2));
    expect(f.connection.capability_states[FIRST]?.status).toBe('unverified');
    expect(f.connection.capability_states[AUTH]?.status).toBe('supported');
  });

  it('a late old query cannot undo a newer whoami probe that shares the execution sequence', async () => {
    const f = await fixture({ [AUTH]: { status: 'needs_auth' }, [FIRST]: { status: 'needs_auth' } });
    const old = f.context(AUTH, false, 1);
    const scheduler = new ProbeScheduler({ db: f.db, connectionMap: new Map([[f.connection.id, f.connection]]),
      probe: async () => ({ status: 'supported' }), resolveTarget: () => ({ whoami: AUTH, capabilities: [AUTH, FIRST, SECOND] }),
      nextSequence: () => 2, onObserved: (id, capId, sequence, ids) => f.verifier.noteProbe(id, capId, sequence, ids), audit: () => undefined });
    await scheduler.runOnce(f.connection.id);
    await f.verifier.observe(f.result(AUTH, 'AUTH_EXPIRED'), old);
    expect(f.connection.capability_states[AUTH]?.status).toBe('supported');
    expect(f.connection.capability_states[FIRST]?.status).toBe('unverified');
  });

  it('does not clear a more recent capability auth failure with an older account auth success', async () => {
    const f = await fixture();
    await f.verifier.observe(f.result(FIRST, 'AUTH_REJECTED'), f.context(FIRST, false, 3));
    await f.verifier.observe(f.result(AUTH), f.context(AUTH, false, 2));
    expect(f.connection.capability_states[FIRST]?.status).toBe('needs_auth');
    expect(f.connection.capability_states[AUTH]?.status).toBe('supported');
  });

  it('normal repeated success preserves the observation time; an explicit verification refreshes it', async () => {
    const f = await fixture({ [FIRST]: { status: 'supported', probed_at: REVISION } });
    await f.verifier.observe(f.result(FIRST), f.context(FIRST));
    expect(f.connection.capability_states[FIRST]?.probed_at).toBe(REVISION);
    await f.verifier.observe(f.result(FIRST), f.context(FIRST, true));
    expect(f.connection.capability_states[FIRST]?.probed_at).not.toBe(REVISION);
    expect(f.connection.updated_at).toBe(REVISION);
  });

  it('a new login signal invalidates old checks without declaring auth valid, while an old settled signal is ignored', async () => {
    const f = await fixture({ [AUTH]: { status: 'supported', probed_at: '2026-02-01T00:00:00.000Z' }, [FIRST]: { status: 'needs_auth' }, disabled: { status: 'disabled' } });
    await f.verifier.loginCompleted(f.connection.id, '2026-01-02T00:00:00.000Z');
    expect(f.connection.capability_states[AUTH]?.status).toBe('supported');
    await f.verifier.loginCompleted(f.connection.id);
    expect(f.connection.capability_states[AUTH]?.status).toBe('unverified');
    expect(f.connection.capability_states[FIRST]?.status).toBe('unverified');
    expect(f.connection.capability_states['disabled']?.status).toBe('disabled');
    expect(f.connection.updated_at).not.toBe(REVISION);
  });
});

async function serverFixture(dispatcher: Dispatcher) {
  const temp = tempDbPath('owngate-status-http-');
  cleanup.push(async () => temp.cleanup());
  const server = await buildServer({ dbPath: temp.path, dispatcher });
  cleanup.push(() => server.app.close());
  server.connectorRegistry.register('status-fixture', { id: 'status-fixture', version: '1', title: 'Fixture', transport: 'http',
    capabilities: Object.fromEntries([AUTH, FIRST, SECOND].map(id => [id, capability(id)])), verification: { auth: AUTH, capabilities: [AUTH] } });
  const admin = await adminWithStepUp(server.app);
  const created = await server.app.inject({ method: 'POST', url: '/admin/connections', headers: admin.headers,
    payload: { connector_id: 'status-fixture', label: 'Status fixture', config: {} } });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  const query = (capabilityId: string, input: unknown = {}) => server.app.inject({ method: 'POST', url: '/admin/invoke', headers: admin.headers,
    payload: { connection_id: id, capability_id: capabilityId, input, no_cache: true } });
  return { server, id, query };
}

describe('ordinary queries write connection status through the execution gate', () => {
  it('two first ordinary queries succeed concurrently and persist both capability states', async () => {
    const f = await serverFixture({ dispatch: async (connection, cap) => ok({ value: 1 }, {
      connection_id: connection.id, connection_label: connection.label, capability_id: cap.id, support: cap.support }) });
    const revision = f.server.services.connections.get(f.id)!.updated_at;
    const responses = await Promise.all([f.query(FIRST), f.query(SECOND)]);
    expect(responses.map(response => response.json().outcome)).toEqual(['success', 'success']);
    const connection = f.server.services.connections.get(f.id)!;
    expect(connection.updated_at).toBe(revision);
    expect(connection.capability_states[FIRST]?.status).toBe('supported');
    expect(connection.capability_states[SECOND]?.status).toBe('supported');
    const stored = (await f.server.db.rawQuery('SELECT capability_states FROM connections WHERE id=?', [f.id]))[0] as { capability_states: string };
    expect(JSON.parse(stored.capability_states)).toMatchObject({ [FIRST]: { status: 'supported' }, [SECOND]: { status: 'supported' } });
  });

  it('an old successful dispatch delayed by audit cannot undo a newer auth failure', async () => {
    const f = await serverFixture({ dispatch: async (connection, cap, input) => {
      const source = { connection_id: connection.id, connection_label: connection.label, capability_id: cap.id, support: cap.support };
      return (input as { fail?: boolean }).fail ? fail(err('AUTH_EXPIRED', 'Fixture session expired'), source) : ok({ value: 1 }, source);
    } });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const append = f.server.services.audit.append;
    f.server.services.audit.append = async entry => {
      if (entry.action === `${AUTH}:success`) { entered(); await wait; }
      await append(entry);
    };
    const old = f.query(AUTH, { fail: false });
    try {
      await blocked;
      const newer = await f.query(AUTH, { fail: true });
      expect(newer.json().error.code).toBe('AUTH_EXPIRED');
      expect(f.server.services.connections.get(f.id)!.capability_states[AUTH]?.status).toBe('needs_auth');
    } finally { release(); }
    expect((await old).json().outcome).toBe('success');
    expect(f.server.services.connections.get(f.id)!.capability_states[AUTH]?.status).toBe('needs_auth');
  });
});
