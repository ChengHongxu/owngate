import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionService, proposalHash } from '../src/actions/service.js';
import { buildServer } from '../src/main.js';
import { adminWithStepUp, tempDbPath } from './helpers/admin.js';
import type { Capability } from '@owngate/core';
import type { DbClient } from '@owngate/db';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
const cap: Capability = { id: 'post.create', title: '发布', description: '', kind: 'action', effect: 'external_send', approval: 'always', transport: 'http',
  input: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', minLength: 1 } } }, output: { type: 'object' }, cache: null, long_running: false, cancel: 'none', idempotency: 'native', verify: null, support: { status: 'disabled' } };
async function fixture() {
  const db = tempDbPath('owngate-actions-'), server = await buildServer({ dbPath: db.path }), admin = await adminWithStepUp(server.app);
  closers.push(async () => { await server.app.close(); db.cleanup(); });
  server.connectorRegistry.register('action-fixture', { id: 'action-fixture', title: 'Fixture', version: '1', transport: 'http', capabilities: { [cap.id]: cap } });
  const connection = (await server.app.inject({ method: 'POST', url: '/admin/connections', headers: admin.headers, payload: { connector_id: 'action-fixture', label: 'Target', config: {} } })).json() as { id: string };
  const created = await server.app.inject({ method: 'POST', url: '/admin/clients', headers: admin.headers, payload: { label: 'Fixture' } });
  const client = created.json() as { id: string; token: string };
  await server.app.inject({ method: 'POST', url: '/admin/grants', headers: admin.headers, payload: { client_id: client.id, connection_id: connection.id, capabilities: ['propose:post.create'] } });
  return { ...server, dbPath: db.path, admin, connection, client, caller: { kind: 'client' as const, client_id: client.id }, adminCaller: { kind: 'admin' as const, user_id: 'fixture-admin' } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Executor = NonNullable<ConstructorParameters<typeof ActionService>[0]['testExecutor']>;
function runner(f: Pick<Fixture, 'db' | 'vault' | 'services' | 'invokeOpts'>, executor: Executor, db = f.db) {
  return new ActionService({ db, vault: f.vault, services: f.services, invokeOpts: f.invokeOpts, testExecutor: executor });
}
/** Mutate the real DB after all preflight reads, immediately before claim SQL. */
function claimBoundary(db: DbClient, before: () => Promise<unknown>, marker = "SET status='running'"): DbClient {
  let changed = false;
  return new Proxy(db, { get(target, key) {
    if (key === 'rawTransaction') return async (statements: Parameters<DbClient['rawTransaction']>[0]) => {
      if (!changed && statements.some((statement) => statement.sql.includes(marker))) { changed = true; await before(); }
      return target.rawTransaction(statements);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
async function approved(f: Fixture, service = f.actionService) {
  const proposal = await service.submit({ connection_id: f.connection.id, capability_id: cap.id, input: { text: 'One authorized attempt' } }, f.caller);
  await service.approve(proposal.id, proposal.normalized_hash, 'admin', 'passkey');
  await f.db.rawRun("UPDATE og_settings SET value='false' WHERE key='actions_paused'");
  return proposal;
}
describe('disabled action proposal framework', () => {
  it('canonicalizes key order without changing user content', () => {
    expect(proposalHash('c', 'a', { b: 1, a: ' text ' }, 'r')).toBe(proposalHash('c', 'a', { a: ' text ', b: 1 }, 'r'));
    expect(proposalHash('c', 'a', { a: ' text ' }, 'r')).not.toBe(proposalHash('c', 'a', { a: 'text' }, 'r'));
  });
  it('encrypts proposal input, denies wildcard query grants, and rechecks revocation', async () => {
    const f = await fixture(), input = { text: 'PRIVATE fixture proposal content' };
    const proposal = await f.actionService.submit({ connection_id: f.connection.id, capability_id: cap.id, input }, f.caller);
    expect(proposal.input).toEqual(input);
    expect(JSON.stringify(await f.db.rawQuery('SELECT * FROM action_proposals'))).not.toContain(input.text);
    await f.app.inject({ method: 'POST', url: '/admin/grants', headers: f.admin.headers, payload: { client_id: f.client.id, connection_id: f.connection.id, capabilities: ['*'] } });
    await expect(f.actionService.get(proposal.id, f.caller)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
  it('invalidates approval when content changes and rejects the old preview hash', async () => {
    const f = await fixture(), p = await f.actionService.submit({ connection_id: f.connection.id, capability_id: cap.id, input: { text: 'First' } }, f.caller);
    await f.actionService.approve(p.id, p.normalized_hash, 'admin', 'totp');
    const updated = await f.actionService.update(p.id, { text: 'Second' }, f.caller);
    expect(updated.status).toBe('pending'); expect(updated.normalized_hash).not.toBe(p.normalized_hash);
    expect(await f.db.rawQuery('SELECT * FROM approvals WHERE proposal_id=?', [p.id])).toEqual([]);
    await expect(f.actionService.approve(p.id, p.normalized_hash, 'admin', 'totp')).rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED' });
  });
  it('never executes a production action, even with valid approval', async () => {
    const f = await fixture(), p = await f.actionService.submit({ connection_id: f.connection.id, capability_id: cap.id, input: { text: 'Never send' } }, f.caller);
    await f.actionService.approve(p.id, p.normalized_hash, 'admin', 'totp');
    await f.db.rawRun("UPDATE og_settings SET value='false' WHERE key='actions_paused'");
    await expect(f.actionService.execute(p.id, f.adminCaller)).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' });
    for (const [prefix, headers] of [['/admin', f.admin.headers], ['/api', { authorization: `Bearer ${f.client.token}` }]] as const) {
      const denied = await f.app.inject({ method: 'POST', url: `${prefix}/proposals/${p.id}/execute`, headers });
      expect(denied.statusCode).toBe(409); expect(denied.json().code).toBe('CAPABILITY_DISABLED');
    }
    expect(await f.db.rawQuery('SELECT * FROM og_action_claims')).toEqual([]);
    const response = await f.app.inject({ method: 'POST', url: `/api/proposals/${p.id}/approve`, headers: { authorization: `Bearer ${f.client.token}` }, payload: { hash: p.normalized_hash } });
    expect(response.statusCode).toBe(404);
  });
  it('checks expiry and connection revision before approval', async () => {
    const f = await fixture(), p = await f.actionService.submit({ connection_id: f.connection.id, capability_id: cap.id, input: { text: 'Preview' } }, f.caller);
    f.services.connections.get(f.connection.id)!.updated_at = 'changed';
    await expect(f.actionService.approve(p.id, p.normalized_hash, 'admin', 'passkey')).rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED' });
    await f.db.rawRun('UPDATE og_action_meta SET expires_at=? WHERE proposal_id=?', ['2000-01-01T00:00:00Z', p.id]);
    expect((await f.actionService.get(p.id, f.caller)).status).toBe('expired');
  });
  it('uses a fenced claim and never retries an unknown remote outcome', async () => {
    const f = await fixture(), executor = vi.fn(async () => { throw new Error('sent then timed out'); });
    const testActions = new ActionService({ db: f.db, vault: f.vault, services: f.services, invokeOpts: f.invokeOpts, testExecutor: executor });
    await testActions.init();
    const p = await testActions.submit({ connection_id: f.connection.id, capability_id: cap.id, input: { text: 'One attempt' } }, f.caller);
    await testActions.approve(p.id, p.normalized_hash, 'admin', 'passkey');
    await f.db.rawRun("UPDATE og_settings SET value='false' WHERE key='actions_paused'");
    const r = await testActions.execute(p.id, f.adminCaller);
    expect(r.status).toBe('unknown_outcome'); expect(r.result).toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: false });
    expect((await testActions.execute(p.id, f.adminCaller)).status).toBe('unknown_outcome'); expect(executor).toHaveBeenCalledTimes(1);
  });
  it('honors the emergency stop in the injected test runner', async () => {
    const f = await fixture(), executor = vi.fn(async () => ({})), testActions = new ActionService({ db: f.db, vault: f.vault, services: f.services, invokeOpts: f.invokeOpts, testExecutor: executor });
    const p = await testActions.submit({ connection_id: f.connection.id, capability_id: cap.id, input: { text: 'Paused' } }, f.caller);
    await testActions.approve(p.id, p.normalized_hash, 'admin', 'totp');
    await f.db.rawRun("UPDATE og_settings SET value='false' WHERE key='actions_paused'");
    await testActions.pause(f.caller);
    await expect(testActions.execute(p.id, f.adminCaller)).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' });
    expect(executor).not.toHaveBeenCalled();
  });
  it('atomically rechecks the stop, approval, proposal, revision and live client grant at the claim boundary', async () => {
    const f = await fixture();
    const revision = f.services.connections.get(f.connection.id)!.updated_at;
    const cases: Array<{ name: string; sql: string; params: (id: string) => unknown[]; client?: boolean }> = [
      { name: 'emergency stop', sql: "UPDATE og_settings SET value='true' WHERE key='actions_paused'", params: () => [] },
      { name: 'approval expired', sql: "UPDATE og_action_approvals SET expires_at='2000-01-01T00:00:00Z' WHERE proposal_id=?", params: (id) => [id] },
      { name: 'approval deleted', sql: 'DELETE FROM approvals WHERE proposal_id=?', params: (id) => [id] },
      { name: 'approval hash changed', sql: 'UPDATE approvals SET approved_hash=? WHERE proposal_id=?', params: (id) => ['f'.repeat(64), id] },
      { name: 'proposal expired', sql: "UPDATE og_action_meta SET expires_at='2000-01-01T00:00:00Z' WHERE proposal_id=?", params: (id) => [id] },
      { name: 'proposal revision changed', sql: "UPDATE og_action_meta SET revision='different' WHERE proposal_id=?", params: (id) => [id] },
      { name: 'connection revision changed', sql: "UPDATE connections SET updated_at='different' WHERE id=?", params: () => [f.connection.id] },
      { name: 'connection paused', sql: 'UPDATE connections SET paused=1 WHERE id=?', params: () => [f.connection.id] },
      { name: 'client revoked', sql: 'UPDATE clients SET revoked=1 WHERE id=?', params: () => [f.client.id], client: true },
      { name: 'proposal grant removed', sql: "UPDATE grants SET capabilities='[\"*\"]' WHERE client_id=?", params: () => [f.client.id], client: true },
    ];
    for (const scenario of cases) {
      await f.db.rawRun('UPDATE connections SET updated_at=?,paused=0 WHERE id=?', [revision, f.connection.id]);
      await f.db.rawRun('UPDATE clients SET revoked=0 WHERE id=?', [f.client.id]);
      await f.db.rawRun('UPDATE grants SET capabilities=? WHERE client_id=?', [JSON.stringify(['propose:post.create']), f.client.id]);
      const proposal = await approved(f), executor = vi.fn(async () => ({ receipt: 'must not send' }));
      const testActions = runner(f, executor, claimBoundary(f.db, () => f.db.rawRun(scenario.sql, scenario.params(proposal.id))));
      await expect(testActions.execute(proposal.id, scenario.client ? f.caller : f.adminCaller), scenario.name).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(executor, scenario.name).not.toHaveBeenCalled();
      expect(await f.db.rawQuery('SELECT * FROM og_action_claims WHERE proposal_id=?', [proposal.id]), scenario.name).toEqual([]);
    }
  });
  it('does not approve a proposal that expires after preflight and before the approval transaction', async () => {
    const f = await fixture(), proposal = await f.actionService.submit({ connection_id: f.connection.id, capability_id: cap.id, input: { text: 'Expires before approval' } }, f.caller);
    const testActions = runner(f, vi.fn(async () => ({})), claimBoundary(f.db, () => f.db.rawRun("UPDATE og_action_meta SET expires_at='2000-01-01T00:00:00Z' WHERE proposal_id=?", [proposal.id]), "SET status='approved'"));
    await expect(testActions.approve(proposal.id, proposal.normalized_hash, 'admin', 'totp')).rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED' });
    expect(await f.db.rawQuery('SELECT * FROM approvals WHERE proposal_id=?', [proposal.id])).toEqual([]);
    expect((await f.actionService.get(proposal.id, f.adminCaller)).status).toBe('expired');
  });
  it('allows only one simultaneous claim and clears its claim token after durable completion', async () => {
    const f = await fixture(), entered = deferred<void>(), finish = deferred<unknown>();
    const executor = vi.fn(async () => { entered.resolve(undefined); return finish.promise; });
    const testActions = runner(f, executor), proposal = await approved(f, testActions);
    const executions = Promise.allSettled([testActions.execute(proposal.id, f.adminCaller), testActions.execute(proposal.id, f.adminCaller)]);
    await entered.promise; expect(executor).toHaveBeenCalledTimes(1);
    const [active] = await f.db.rawQuery('SELECT attempt,token FROM og_action_claims WHERE proposal_id=?', [proposal.id]) as Array<{ attempt: number; token: string | null }>;
    expect(active?.attempt).toBe(1); expect(active?.token).toBeTypeOf('string');
    finish.resolve({ receipt: 'PRIVATE remote receipt' });
    const settled = await executions; expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1); expect(settled.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    const result = await testActions.execute(proposal.id, f.adminCaller); expect(result.status).toBe('executed'); expect(result.result).toEqual({ receipt: 'PRIVATE remote receipt' }); expect(executor).toHaveBeenCalledTimes(1);
    const [completed] = await f.db.rawQuery('SELECT attempt,token FROM og_action_claims WHERE proposal_id=?', [proposal.id]); expect(completed).toMatchObject({ attempt: 1, token: null });
    expect(JSON.stringify(await f.db.rawQuery('SELECT result FROM og_action_meta WHERE proposal_id=?', [proposal.id]))).not.toContain('PRIVATE remote receipt');
  });
  it('recovers interrupted work to unknown_outcome and fences a late completion without retrying', async () => {
    const f = await fixture(), entered = deferred<void>(), finish = deferred<unknown>();
    const old = runner(f, vi.fn(async () => { entered.resolve(undefined); return finish.promise; }));
    const proposal = await approved(f, old), pending = old.execute(proposal.id, f.adminCaller);
    await entered.promise;
    const retry = vi.fn(async () => ({ receipt: 'duplicate' })), recovered = runner(f, retry); await recovered.init();
    const view = await recovered.get(proposal.id, f.adminCaller); expect(view.status).toBe('unknown_outcome'); expect(view.result).toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: false, reason: 'interrupted_execution' });
    expect((await recovered.execute(proposal.id, f.adminCaller)).status).toBe('unknown_outcome'); expect(retry).not.toHaveBeenCalled();
    finish.resolve({ receipt: 'late result must not overwrite recovery' }); expect((await pending).status).toBe('unknown_outcome');
    expect((await recovered.get(proposal.id, f.adminCaller)).result).toEqual(view.result);
    expect(await f.db.rawQuery("SELECT * FROM audit_log WHERE action='action.executed' AND target=?", [proposal.id])).toEqual([]);
    const claims = await f.db.rawQuery('SELECT attempt,token FROM og_action_claims WHERE proposal_id=?', [proposal.id]); expect(claims[0]).toMatchObject({ attempt: 1, token: null });
    await expect(recovered.update(proposal.id, { text: 'Never retry' }, f.adminCaller)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('prevents an old attempt from overwriting a later running claim even when status is running again', async () => {
    const f = await fixture(), firstEntered = deferred<void>(), secondEntered = deferred<void>(), firstDone = deferred<unknown>(), secondDone = deferred<unknown>();
    let calls = 0;
    const executor = vi.fn(async () => { if (++calls === 1) { firstEntered.resolve(undefined); return firstDone.promise; } secondEntered.resolve(undefined); return secondDone.promise; });
    const actions = runner(f, executor), proposal = await approved(f, actions);
    const old = actions.execute(proposal.id, f.adminCaller); await firstEntered.promise;
    const next = runner(f, executor); await next.init();
    // Fault injection models an operator repairing a record outside the API.
    // No production route or service transition permits retrying unknown work.
    await f.db.rawTransaction([
      { sql: "UPDATE action_proposals SET status='pending' WHERE id=?", params: [proposal.id] },
      { sql: 'UPDATE og_action_meta SET result=NULL WHERE proposal_id=?', params: [proposal.id] },
    ]);
    await next.approve(proposal.id, proposal.normalized_hash, 'admin', 'passkey');
    const current = next.execute(proposal.id, f.adminCaller); await secondEntered.promise;
    firstDone.resolve({ receipt: 'old' }); const stale = await old; expect(stale.status).toBe('running'); expect(stale.result).toBeNull();
    const [claim] = await f.db.rawQuery('SELECT attempt,token FROM og_action_claims WHERE proposal_id=?', [proposal.id]) as Array<{ attempt: number; token: string | null }>;
    expect(claim?.attempt).toBe(2); expect(claim?.token).toBeTypeOf('string');
    secondDone.resolve({ receipt: 'current' }); const winner = await current; expect(winner.status).toBe('executed'); expect(winner.result).toEqual({ receipt: 'current' });
    expect(await f.db.rawQuery("SELECT * FROM audit_log WHERE action='action.executed' AND target=?", [proposal.id])).toHaveLength(1);
  });
  it('recovers running work after an actual server/database restart and keeps the old worker fenced', async () => {
    const f = await fixture(), entered = deferred<void>(), finish = deferred<unknown>();
    const actions = runner(f, vi.fn(async () => { entered.resolve(undefined); return finish.promise; })), proposal = await approved(f, actions);
    const pending = actions.execute(proposal.id, f.adminCaller).then((value) => ({ value }), (error: unknown) => ({ error }));
    await entered.promise; await f.app.close();
    const restarted = await buildServer({ dbPath: f.dbPath }); closers.unshift(() => restarted.app.close());
    restarted.connectorRegistry.register('action-fixture', { id: 'action-fixture', title: 'Fixture', version: '1', transport: 'http', capabilities: { [cap.id]: cap } });
    const recovered = await restarted.actionService.get(proposal.id, f.adminCaller); expect(recovered.status).toBe('unknown_outcome'); expect(recovered.result).toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: false });
    const retry = vi.fn(async () => ({ receipt: 'must never retry' })), injected = runner(restarted, retry);
    expect((await injected.execute(proposal.id, f.adminCaller)).status).toBe('unknown_outcome'); expect(retry).not.toHaveBeenCalled();
    finish.resolve({ receipt: 'old process late result' }); expect(await pending).toHaveProperty('error');
    expect((await restarted.actionService.get(proposal.id, f.adminCaller)).result).toEqual(recovered.result);
    const claims = await restarted.db.rawQuery('SELECT attempt,token FROM og_action_claims WHERE proposal_id=?', [proposal.id]); expect(claims[0]).toMatchObject({ attempt: 1, token: null });
  });
});
