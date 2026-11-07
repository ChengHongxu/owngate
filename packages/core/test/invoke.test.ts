import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke, reserveInvocationSequence } from '../src/invoke/index.js';
import type {
  InvokeRequest, InvokeServices, InvokeOptions,
  CapabilityRegistry, ConnectionStore, AuthStore,
  CacheStore, AuditStore, Dispatcher,
  ExecutionEvent,
} from '../src/invoke/index.js';
import type { Capability, Connection, Client, Grant } from '../src/types/index.js';
import type { ResultEnvelope } from '../src/envelope/index.js';

// ── Test fixtures ─────────────────────────────────────────────────────────

const CAP: Capability = {
  id: 'account.balance',
  kind: 'query',
  title: 'Account Balance',
  description: 'Current balance',
  effect: 'read',
  approval: 'never',
  input: { type: 'object' },
  output: { type: 'object', properties: { balance: { type: 'number' } } },
  cache: { ttl: 60 },
  long_running: false,
  cancel: 'none',
  idempotency: 'none',
  verify: null,
  transport: 'http',
  support: { status: 'supported' },
};

const CONN: Connection = {
  id: 'conn-1',
  connector_id: 'test',
  label: 'Test Site',
  config: {},
  capability_states: {},
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const CLIENT: Client = {
  id: 'client-1',
  label: 'Test CLI',
  revoked: false,
  created_at: '2024-01-01T00:00:00Z',
};

const GRANT: Grant = {
  client_id: 'client-1',
  connection_id: 'conn-1',
  capabilities: ['account.balance'],
};

function makeServices(overrides: Partial<InvokeServices> = {}): InvokeServices {
  const dispatchResult: ResultEnvelope = {
    status: 'ok',
    outcome: 'success',
    data: { balance: 42 },
    error: null,
    fields: {},
    source: { connection_id: 'conn-1', connection_label: 'Test Site', capability_id: 'account.balance', support: { status: 'supported' } },
    data_time: '2024-01-01T00:00:00Z',
    queried_at: '2024-01-01T00:00:00Z',
    cache: null,
    warnings: [],
  };

  return {
    capabilities: { get: (cid, aid) => (cid === 'test' && aid === 'account.balance' ? CAP : undefined) },
    connections: { get: (id) => (id === 'conn-1' ? CONN : undefined) },
    auth: {
      getClient: (hash) => (hash === 'hash-good' ? CLIENT : undefined),
      getGrants: (cid) => (cid === 'client-1' ? [GRANT] : []),
    },
    cache: { get: () => undefined, set: vi.fn(), invalidate: vi.fn() },
    audit: { append: vi.fn() },
    dispatch: { dispatch: vi.fn().mockResolvedValue(dispatchResult) },
    ...overrides,
  };
}

const OPTS: InvokeOptions = {
  hashToken: (t) => t === 'good-token' ? 'hash-good' : 'hash-bad',
  redactOutput: (data) => data, // identity for unit tests
};

const REQ: InvokeRequest = {
  token: 'good-token',
  connection_id: 'conn-1',
  capability_id: 'account.balance',
  input: {},
};

describe('administrator execution observations', () => {
  it('stops at invalid input without dispatching or inventing downstream steps', async () => {
    const events: ExecutionEvent[] = [];
    const services = makeServices({ capabilities: { get: () => ({ ...CAP, input: { type: 'object', additionalProperties: false } }) } });
    const result = await invoke({ ...REQ, input: { unexpected: 'never-include-this-input' } }, services,
      { ...OPTS, onExecutionEvent: event => events.push(event) }, { kind: 'admin', user_id: 'fixture-admin' });
    expect(result.error?.code).toBe('INVALID_PARAMS');
    expect(services.dispatch.dispatch).not.toHaveBeenCalled();
    expect(events.filter(event => event.type === 'finish')).toMatchObject([
      { id: 'request.validate', status: 'success' }, { id: 'request.input', status: 'error', code: 'INVALID_PARAMS' },
      { id: 'request.denied', status: 'success' },
    ]);
    expect(JSON.stringify(events)).not.toContain('never-include-this-input');
    expect(events.some(event => event.id === 'request.execute')).toBe(false);
  });

  it('records output validation failure at its actual validation boundary', async () => {
    const events: ExecutionEvent[] = [];
    const services = makeServices({ capabilities: { get: () => ({ ...CAP, output: { type: 'object', required: ['missing'] } }) } });
    const result = await invoke(REQ, services, { ...OPTS, onExecutionEvent: event => events.push(event) }, { kind: 'admin', user_id: 'fixture-admin' });
    expect(result.error?.code).toBe('PARSE_FAILED');
    expect(events.filter(event => event.type === 'finish')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'request.execute', status: 'success' }),
      expect.objectContaining({ id: 'request.output', status: 'error', code: 'PARSE_FAILED' }),
    ]));
  });

  it.each(['connection', 'execution', 'output'] as const)('keeps private %s failure messages in the business envelope and out of observations', async (stage) => {
    const privateText = 'x.com/private-account-name Error: private-exception-detail';
    const events: ExecutionEvent[] = [];
    const services = makeServices();
    if (stage === 'connection') {
      services.connections.get = () => ({ ...CONN, capability_states: {
        [CAP.id]: { status: 'needs_auth', reason: privateText },
      } });
    } else if (stage === 'execution') {
      const source = { connection_id: CONN.id, connection_label: CONN.label, capability_id: CAP.id, support: CAP.support };
      services.dispatch.dispatch = async () => ({
        status: 'error', outcome: 'error', data: null,
        error: { code: 'UPSTREAM_ERROR', message: privateText, retryable: false },
        fields: {}, source, data_time: '', queried_at: '', cache: null, warnings: [],
      });
    } else {
      services.capabilities.get = () => ({ ...CAP, output: {
        type: 'object', required: [privateText],
      } });
    }
    const result = await invoke(REQ, services, { ...OPTS, onExecutionEvent: event => events.push(event) },
      { kind: 'admin', user_id: 'fixture-admin' });
    expect(result.outcome).toBe('error');
    expect(result.error?.message).toContain(privateText);
    const observed = JSON.stringify(events);
    expect(observed).not.toContain('private-account-name');
    expect(observed).not.toContain('private-exception-detail');
    expect(events.some(event => event.type === 'finish' && event.status === 'error' && event.code === result.error?.code)).toBe(true);
  });

  it('ignores throwing observers and never invokes them for token clients', async () => {
    const observer = vi.fn(() => { throw new Error('diagnostic sink unavailable'); });
    const options = { ...OPTS, onExecutionEvent: observer };
    expect((await invoke(REQ, makeServices(), options, { kind: 'admin', user_id: 'fixture-admin' })).outcome).toBe('success');
    expect(observer).toHaveBeenCalled(); observer.mockClear();
    expect((await invoke(REQ, makeServices(), options)).outcome).toBe('success');
    expect(observer).not.toHaveBeenCalled();
  });

  it('does not forward cached administrator diagnostics into client or durable results', async () => {
    const services = makeServices();
    const original = await invoke(REQ, services, OPTS);
    const cached: ResultEnvelope = { ...original, execution: { id: 'older-admin', started_at: new Date().toISOString(), duration_ms: 2, steps: [] } };
    services.cache.get = () => ({ envelope: cached, cached_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), ttl: 60 });
    const authorized = vi.fn();
    const result = await invoke(REQ, services, { ...OPTS, onAuthorizedResult: authorized });
    expect(result.cache?.hit).toBe(true);
    expect(result).not.toHaveProperty('execution');
    expect(authorized).toHaveBeenCalledWith(expect.not.objectContaining({ execution: expect.anything() }));
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('invoke() auth', () => {
  it('returns UNAUTHENTICATED for unknown token', async () => {
    const env = await invoke({ ...REQ, token: 'bad-token' }, makeServices(), OPTS);
    expect(env.outcome).toBe('error');
    expect(env.status).toBe('forbidden');
    expect(env.error?.code).toBe('UNAUTHENTICATED');
  });

  it('returns CLIENT_REVOKED for revoked client', async () => {
    const svc = makeServices({
      auth: {
        getClient: () => ({ ...CLIENT, revoked: true }),
        getGrants: () => [GRANT],
      },
    });
    const env = await invoke(REQ, svc, OPTS);
    expect(env.error?.code).toBe('CLIENT_REVOKED');
  });

  it('returns CONNECTION_NOT_FOUND for unknown connection', async () => {
    const env = await invoke({ ...REQ, connection_id: 'unknown' }, makeServices(), OPTS);
    expect(env.error?.code).toBe('CONNECTION_NOT_FOUND');
  });

  it('returns CAPABILITY_NOT_FOUND for unknown capability', async () => {
    const env = await invoke({ ...REQ, capability_id: 'nope.nope' }, makeServices(), OPTS);
    expect(env.error?.code).toBe('CAPABILITY_NOT_FOUND');
  });

  it('returns PERMISSION_DENIED when no grant for connection', async () => {
    const svc = makeServices({ auth: { getClient: () => CLIENT, getGrants: () => [] } });
    const env = await invoke(REQ, svc, OPTS);
    expect(env.error?.code).toBe('PERMISSION_DENIED');
  });

  it('returns PERMISSION_DENIED when capability not in grant', async () => {
    const svc = makeServices({
      auth: {
        getClient: () => CLIENT,
        getGrants: () => [{ ...GRANT, capabilities: ['other.cap'] }],
      },
    });
    const env = await invoke(REQ, svc, OPTS);
    expect(env.error?.code).toBe('PERMISSION_DENIED');
  });

  it('allows wildcard grant', async () => {
    const svc = makeServices({
      auth: {
        getClient: () => CLIENT,
        getGrants: () => [{ ...GRANT, capabilities: ['*'] }],
      },
    });
    const env = await invoke(REQ, svc, OPTS);
    expect(env.outcome).toBe('success');
  });
});

describe('invoke() support status', () => {
  it.each(['unverified', 'unavailable'] as const)('allows a granted read-only query in %s state to gather current evidence', async (status) => {
    const svc = makeServices({ connections: { get: () => ({ ...CONN, capability_states: { [CAP.id]: { status } } }) } });
    expect((await invoke(REQ, svc, OPTS)).outcome).toBe('success');
    expect(svc.dispatch.dispatch).toHaveBeenCalledOnce();
  });

  it('returns AUTH_EXPIRED when the connection override says needs_auth', async () => {
    const svc = makeServices({
      connections: {
        get: () => ({
          ...CONN,
          capability_states: { 'account.balance': { status: 'needs_auth', reason: 'login expired' } },
        }),
      },
    });
    const env = await invoke(REQ, svc, OPTS);
    expect(env.error?.code).toBe('AUTH_EXPIRED');
    expect(env.status).toBe('needs_reauth');
  });

  it('returns AUTH_MISSING when needs_auth is the connector default', async () => {
    const svc = makeServices({
      capabilities: { get: () => ({ ...CAP, support: { status: 'needs_auth' } }) },
      connections: { get: () => ({ ...CONN, capability_states: {} }) },
    });
    const env = await invoke(REQ, svc, OPTS);
    expect(env.error?.code).toBe('AUTH_MISSING');
    expect(env.status).toBe('needs_reauth');
  });

  it.each([
    ['needs_plan', 'PLAN_INSUFFICIENT'],
    ['unsupported', 'CAPABILITY_UNSUPPORTED'],
    ['disabled', 'CAPABILITY_DISABLED'],
  ] as const)('maps support status %s to %s', async (status, code) => {
    const svc = makeServices({
      connections: {
        get: () => ({ ...CONN, capability_states: { 'account.balance': { status } } }),
      },
    });
    const env = await invoke(REQ, svc, OPTS);
    expect(env.error?.code).toBe(code);
    expect(env.status).toBe('unsupported');
  });

  it('returns CAPABILITY_DISABLED for action capabilities', async () => {
    const actionCap: Capability = { ...CAP, id: 'post.create', kind: 'action', cache: null };
    const svc = makeServices({
      capabilities: { get: () => actionCap },
      connections: { get: () => ({ ...CONN, capability_states: {} }) },
      auth: {
        getClient: () => CLIENT,
        getGrants: () => [{ ...GRANT, capabilities: ['post.create'] }],
      },
    });
    const env = await invoke({ ...REQ, capability_id: 'post.create' }, svc, OPTS);
    expect(env.error?.code).toBe('CAPABILITY_DISABLED');
  });
});

describe('fresh invocation result observations', () => {
  it('observes a filtered copy and adopts only the returned support state', async () => {
    const services = makeServices();
    const observer = vi.fn<NonNullable<InvokeOptions['onInvocationResult']>>(async (result) => {
      expect(result.data).toEqual({ balance: null });
      expect(result.fields['balance']?.status).toBe('redacted');
      (result.data as { balance: number | null }).balance = 9000;
      result.warnings.push('observer-only warning');
      return { status: 'supported' as const, probed_at: '2026-11-07T00:00:00Z', reason: 'observer-private-text' };
    });
    const result = await invoke(REQ, services, { ...OPTS, redactOutput: () => ({ balance: null }),
      sanitize: value => JSON.parse(JSON.stringify(value).replaceAll('observer-private-text', '[redacted]')),
      onInvocationResult: observer });
    expect(observer).toHaveBeenCalledOnce();
    expect(observer.mock.calls[0]).toHaveLength(2);
    expect(observer.mock.calls[0]?.[1]).toEqual({ connection: CONN, capability: CAP, revision: CONN.updated_at, verification: false, sequence: 1 });
    expect(result.data).toEqual({ balance: null });
    expect(result.warnings).toEqual([]);
    expect(result.source.support).toEqual({ status: 'supported', probed_at: '2026-11-07T00:00:00Z', reason: '[redacted]' });
  });

  it('reports output validation failure rather than an unvalidated successful response', async () => {
    const services = makeServices({ capabilities: { get: () => ({ ...CAP, output: { type: 'object', required: ['missing'] } }) } });
    const observer = vi.fn<NonNullable<InvokeOptions['onInvocationResult']>>(async () => ({ status: 'needs_adapter' }));
    const result = await invoke(REQ, services, { ...OPTS, onInvocationResult: observer });
    expect(observer).toHaveBeenCalledOnce();
    expect(observer.mock.calls[0]?.[0]).toMatchObject({ outcome: 'error', data: null, error: { code: 'PARSE_FAILED' } });
    expect(result.source.support.status).toBe('needs_adapter');
    expect(services.cache.set).not.toHaveBeenCalled();
  });

  it('observes a dispatcher exception as a failed execution without exposing its exception', async () => {
    const services = makeServices({ dispatch: { dispatch: vi.fn(async () => { throw new Error('private connector exception'); }) } });
    const observer = vi.fn<NonNullable<InvokeOptions['onInvocationResult']>>(async () => ({ status: 'unavailable' }));
    const result = await invoke(REQ, services, { ...OPTS, onInvocationResult: observer });
    expect(observer).toHaveBeenCalledOnce();
    expect(observer.mock.calls[0]?.[0]).toMatchObject({ outcome: 'error', error: { code: 'INTERNAL_ERROR' } });
    expect(result.source.support.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('private connector exception');
  });

  it('identifies explicit administrator verification while observation updates only runtime state', async () => {
    const connection: Connection = { ...CONN, capability_states: { [CAP.id]: { status: 'unverified' } } };
    const services = makeServices({ connections: { get: () => connection } });
    const observer = vi.fn(async (_result: ResultEnvelope, context: import('../src/invoke/index.js').InvocationResultContext) => {
      expect(context.verification).toBe(true);
      expect(context.revision).toBe(CONN.updated_at);
      connection.capability_states = { [CAP.id]: { status: 'supported' as const } };
      return connection.capability_states[CAP.id];
    });
    const result = await invoke(REQ, services, { ...OPTS, onInvocationResult: observer }, { kind: 'admin', user_id: 'admin', verify: true });
    expect(result.outcome).toBe('success');
    expect(result.source.support.status).toBe('supported');
    expect(observer).toHaveBeenCalledOnce();
  });

  it.each(['success', 'partial'] as const)('refuses %s data when configuration changes during an asynchronous observation', async (outcome) => {
    const connection = { ...CONN };
    const services = makeServices({ connections: { get: () => connection } });
    const execute = vi.mocked(services.dispatch.dispatch).getMockImplementation()!;
    if (outcome === 'partial') services.dispatch.dispatch = vi.fn(async (...args: Parameters<Dispatcher['dispatch']>): Promise<ResultEnvelope> => ({
      ...await execute(...args), status: 'partial', outcome: 'partial',
      error: { code: 'ITEM_PARSE_FAILED', message: 'One record was unavailable', retryable: false },
    }));
    const result = await invoke(REQ, services, { ...OPTS, onInvocationResult: async () => {
      await Promise.resolve();
      connection.updated_at = '2026-11-07T00:00:00Z';
      return { status: 'supported' };
    } });
    expect(result.error?.code).toBe('GRANT_REVOKED');
    expect(result.data).toBeNull();
  });

  it.each(['paused', 'removed', 'cancelled'] as const)('refuses data when execution becomes %s during observation', async (change) => {
    let connection: Connection | undefined = { ...CONN };
    const controller = new AbortController();
    const services = makeServices({ connections: { get: () => connection } });
    const result = await invoke(REQ, services, { ...OPTS, signal: controller.signal, onInvocationResult: async () => {
      await Promise.resolve();
      if (change === 'paused') connection!.paused = true;
      else if (change === 'removed') connection = undefined;
      else controller.abort();
      return { status: 'supported' };
    } });
    expect(result.error?.code).toBe(change === 'removed' ? 'CONNECTION_NOT_FOUND' : 'CAPABILITY_DISABLED');
    expect(result.data).toBeNull();
  });

  it('preserves the actual execution error when observation races a configuration change', async () => {
    const connection = { ...CONN };
    const services = makeServices({ connections: { get: () => connection } });
    const execute = vi.mocked(services.dispatch.dispatch).getMockImplementation()!;
    services.dispatch.dispatch = vi.fn(async (...args: Parameters<Dispatcher['dispatch']>): Promise<ResultEnvelope> => ({ ...await execute(...args),
      status: 'error', outcome: 'error', data: null,
      error: { code: 'UPSTREAM_TIMEOUT', message: 'The site timed out', retryable: true },
    }));
    const result = await invoke(REQ, services, { ...OPTS, onInvocationResult: async () => {
      await Promise.resolve();
      connection.updated_at = '2026-11-07T00:00:00Z';
      return undefined;
    } });
    expect(result.error?.code).toBe('UPSTREAM_TIMEOUT');
    expect(result.data).toBeNull();
  });

  it('shares a local dispatch sequence among deduplicated callers and advances it for a new execution', async () => {
    const services = makeServices();
    const execute = vi.mocked(services.dispatch.dispatch).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    services.dispatch.dispatch = vi.fn(async (...args: Parameters<Dispatcher['dispatch']>) => { await gate; return execute(...args); });
    const sequences: number[] = [];
    const options: InvokeOptions = { ...OPTS, onInvocationResult: (_result, context) => { sequences.push(context.sequence); return undefined; } };
    const first = invoke(REQ, services, options);
    const second = invoke(REQ, services, options);
    await vi.waitFor(() => expect(services.dispatch.dispatch).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, second]);
    expect(sequences).toEqual([1, 1]);
    await invoke({ ...REQ, input: { distinct: true } }, services, options);
    expect(sequences).toEqual([1, 1, 2]);
    expect(services.dispatch.dispatch).toHaveBeenCalledTimes(2);
  });

  it('keeps dispatch order trustworthy when an older result reaches observation after a newer result', async () => {
    const services = makeServices();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const olderAudit = new Promise<void>(done => { entered = done; });
    let audits = 0;
    services.audit.append = vi.fn(async () => { if (++audits === 1) { entered(); await gate; } });
    const sequences: number[] = [];
    const options: InvokeOptions = { ...OPTS, onInvocationResult: (_result, context) => { sequences.push(context.sequence); return undefined; } };
    const older = invoke({ ...REQ, no_cache: true }, services, options);
    await olderAudit;
    await invoke({ ...REQ, no_cache: true, input: { distinct: true } }, services, options);
    expect(sequences).toEqual([2]);
    release();
    await older;
    expect(sequences).toEqual([2, 1]);
  });

  it('ignores a failed state observer without corrupting the authorized query', async () => {
    const observer = vi.fn(async (result: ResultEnvelope) => {
      (result.data as { balance: number }).balance = -1;
      throw new Error('state store unavailable');
    });
    const result = await invoke(REQ, makeServices(), { ...OPTS, onInvocationResult: observer });
    expect(result.outcome).toBe('success');
    expect(result.data).toEqual({ balance: 42 });
    expect(observer).toHaveBeenCalledOnce();
  });

  it.each(['client', 'grant'] as const)('rechecks current %s authorization after an asynchronous state write', async (change) => {
    const services = makeServices();
    const observer = vi.fn(async () => {
      await Promise.resolve();
      if (change === 'client') services.auth.getClient = () => ({ ...CLIENT, revoked: true });
      else services.auth.getGrants = () => [];
      return { status: 'supported' as const };
    });
    const result = await invoke(REQ, services, { ...OPTS, onInvocationResult: observer });
    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe(change === 'client' ? 'CLIENT_REVOKED' : 'PERMISSION_DENIED');
    expect(result.data).toBeNull();
  });

  it('reapplies current field visibility after observation without repeating private result capture', async () => {
    let grant: Grant = { ...GRANT, visibility: { financial: true } };
    const services = makeServices({ auth: { getClient: () => CLIENT, getGrants: () => [grant] } });
    const capture = vi.fn();
    const result = await invoke(REQ, services, { ...OPTS, onAuthorizedResult: capture,
      redactOutput: (data, _capability, _audience, _client, currentGrant) => currentGrant?.visibility?.financial === false ? { balance: null } : data,
      onInvocationResult: async value => {
        expect(value.data).toEqual({ balance: 42 });
        await Promise.resolve();
        grant = { ...grant, visibility: { financial: false } };
        return { status: 'supported' };
      },
    });
    expect(result.outcome).toBe('success');
    expect(result.data).toEqual({ balance: null });
    expect(result.fields['balance']?.status).toBe('redacted');
    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]?.[0].data).toEqual({ balance: 42 });
  });

  it('shares trusted ordering between server probes and actual invocation dispatches', async () => {
    const services = makeServices();
    const sequences: number[] = [];
    const options: InvokeOptions = { ...OPTS, onInvocationResult: (_result, context) => { sequences.push(context.sequence); return undefined; } };
    expect(reserveInvocationSequence(services)).toBe(1);
    await invoke(REQ, services, options);
    expect(sequences).toEqual([2]);
    expect(reserveInvocationSequence(services)).toBe(3);
    await invoke({ ...REQ, input: { distinct: true } }, services, options);
    expect(sequences).toEqual([2, 4]);
    expect(reserveInvocationSequence(makeServices())).toBe(1);
  });

  it('does not treat a cache hit as fresh evidence', async () => {
    const services = makeServices();
    const previous = await invoke(REQ, services, OPTS);
    services.cache.get = () => ({ envelope: previous, cached_at: '2026-11-06T00:00:00Z', expires_at: '2100-01-01', ttl: 60 });
    const observer = vi.fn();
    const result = await invoke(REQ, services, { ...OPTS, onInvocationResult: observer });
    expect(result.cache?.hit).toBe(true);
    expect(observer).not.toHaveBeenCalled();
  });

  it('returns current support with cached data without mutating the cache or creating fresh evidence', async () => {
    const connection: Connection = { ...CONN, capability_states: { [CAP.id]: { status: 'unverified' } } };
    const capability: Capability = { ...CAP };
    let cached: import('../src/invoke/index.js').CachedResult | undefined;
    const services = makeServices({ connections: { get: () => connection }, capabilities: { get: () => capability }, cache: {
      get: () => cached, invalidate: () => {},
      set: (_key, envelope, ttl) => { cached = { envelope, ttl, cached_at: '2026-11-07T00:00:00Z', expires_at: '2100-01-01' }; },
    } });
    const execute = vi.mocked(services.dispatch.dispatch).getMockImplementation()!;
    services.dispatch.dispatch = vi.fn(async (...args: Parameters<Dispatcher['dispatch']>): Promise<ResultEnvelope> => ({ ...await execute(...args),
      source: { connection_id: CONN.id, connection_label: CONN.label, capability_id: CAP.id, support: { status: 'unverified' } },
    }));
    const observer = vi.fn<NonNullable<InvokeOptions['onInvocationResult']>>(() => {
      const state = { status: 'supported' as const, probed_at: '2026-11-07T00:00:00Z' };
      connection.capability_states[CAP.id] = state;
      return state;
    });
    const first = await invoke(REQ, services, { ...OPTS, onInvocationResult: observer });
    expect(first.source.support.status).toBe('supported');
    expect(cached!.envelope.source.support).toEqual({ status: 'unverified' });
    const second = await invoke(REQ, services, { ...OPTS, onInvocationResult: observer });
    expect(second.cache?.hit).toBe(true);
    expect(second.source.support).toEqual(connection.capability_states[CAP.id]);
    second.source.support.reason = 'return-only change';
    expect(connection.capability_states[CAP.id]).not.toHaveProperty('reason');
    expect(cached!.envelope.source.support).toEqual({ status: 'unverified' });
    delete connection.capability_states[CAP.id];
    capability.support = { status: 'partial' };
    expect((await invoke(REQ, services, { ...OPTS, onInvocationResult: observer })).source.support.status).toBe('partial');
    expect(observer).toHaveBeenCalledOnce();
    expect(services.dispatch.dispatch).toHaveBeenCalledOnce();
  });

  it.each(['unauthorized', 'invalid_input', 'disabled', 'write'] as const)('does not observe a %s rejection as a site result', async (rejection) => {
    const services = makeServices();
    const observer = vi.fn();
    let request = REQ;
    if (rejection === 'unauthorized') request = { ...REQ, token: 'bad-token' };
    else if (rejection === 'invalid_input') services.capabilities.get = () => ({ ...CAP, input: { type: 'object', required: ['missing'] } });
    else if (rejection === 'disabled') services.connections.get = () => ({ ...CONN, capability_states: { [CAP.id]: { status: 'disabled' } } });
    else services.capabilities.get = () => ({ ...CAP, kind: 'action', effect: 'write' });
    expect((await invoke(request, services, { ...OPTS, onInvocationResult: observer })).outcome).toBe('error');
    expect(services.dispatch.dispatch).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
  });

  it('does not observe a queued request rejected before dispatch as a failed capability', async () => {
    const connection = { ...CONN };
    const services = makeServices({ connections: { get: () => connection } });
    const execute = vi.mocked(services.dispatch.dispatch).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    services.dispatch.dispatch = vi.fn(async (...args: Parameters<Dispatcher['dispatch']>) => { await gate; return execute(...args); });
    const first = invoke(REQ, services, OPTS);
    await vi.waitFor(() => expect(services.dispatch.dispatch).toHaveBeenCalledOnce());
    const observer = vi.fn();
    const queued = invoke({ ...REQ, input: { distinct: true } }, services, { ...OPTS, onInvocationResult: observer });
    await new Promise(done => setImmediate(done));
    connection.paused = true;
    release();
    await first;
    const result = await queued;
    expect(result.error?.code).toBe('CAPABILITY_DISABLED');
    expect(services.dispatch.dispatch).toHaveBeenCalledOnce();
    expect(observer).not.toHaveBeenCalled();
  });
});

describe('invoke() cache', () => {
  it('returns cache hit with cache metadata', async () => {
    const cachedEnvelope: ResultEnvelope = {
      status: 'ok',
      outcome: 'success',
      data: { balance: 99 },
      error: null,
      fields: {},
      source: { connection_id: 'conn-1', connection_label: 'Test Site', capability_id: 'account.balance', support: { status: 'supported' } },
      data_time: '2024-01-01T00:00:00Z',
      queried_at: '2024-01-01T00:00:00Z',
      cache: null,
      warnings: [],
    };
    const svc = makeServices({
      cache: {
        get: () => ({
          envelope: cachedEnvelope,
          cached_at: '2024-01-01T00:00:00Z',
          expires_at: new Date(Date.now() + 60000).toISOString(),
          ttl: 60,
        }),
        set: vi.fn(),
        invalidate: vi.fn(),
      },
    });
    const env = await invoke(REQ, svc, OPTS);
    expect(env.outcome).toBe('success');
    expect(env.cache?.hit).toBe(true);
    expect((env.data as { balance: number }).balance).toBe(99);
  });

  it('bypasses cache with no_cache flag', async () => {
    const mockSet = vi.fn();
    const svc = makeServices({
      cache: { get: () => undefined, set: mockSet, invalidate: vi.fn() },
    });
    await invoke({ ...REQ, no_cache: true }, svc, OPTS);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('stores result in cache after fresh dispatch', async () => {
    const mockSet = vi.fn();
    const svc = makeServices({
      cache: { get: () => undefined, set: mockSet, invalidate: vi.fn() },
    });
    await invoke(REQ, svc, OPTS);
    expect(mockSet).toHaveBeenCalledOnce();
  });
});

describe('invoke() happy path', () => {
  it('returns success envelope with correct source', async () => {
    const env = await invoke(REQ, makeServices(), OPTS);
    expect(env.outcome).toBe('success');
    expect(env.source.connection_id).toBe('conn-1');
    expect(env.source.capability_id).toBe('account.balance');
    expect((env.data as { balance: number }).balance).toBe(42);
  });

  it('writes audit entry', async () => {
    const appendMock = vi.fn();
    const svc = makeServices({ audit: { append: appendMock } });
    await invoke(REQ, svc, OPTS);
    expect(appendMock).toHaveBeenCalledOnce();
    expect(appendMock.mock.calls[0]?.[0]?.action).toContain('account.balance');
  });

  it('audits only input structure and a stable fingerprint for execution and cache hits', async () => {
    const capability: Capability = { ...CAP, input: { type: 'object', properties: {
      password: { type: 'string', 'x-secret': true },
      contact: { type: 'object', properties: { email: { type: 'string', 'x-sensitivity': 'pii' } } },
      post: { type: 'string', 'x-sensitivity': 'content' },
      amount: { type: 'number', 'x-sensitivity': 'financial' },
    } } };
    const input = { password: 'audit-private-password', contact: { email: 'private@example.test' }, post: 'private draft body', amount: 1234567.89,
      'unlisted-private-key@example.test': 'private unclassified value' };
    const stored = new Map<string, { envelope: ResultEnvelope; cached_at: string; expires_at: string; ttl: number }>();
    const append = vi.fn();
    const services = makeServices({ capabilities: { get: () => capability }, audit: { append }, cache: {
      get: (key) => stored.get(key), invalidate: () => {},
      set: (key, envelope, ttl) => { stored.set(key, { envelope, ttl, cached_at: new Date().toISOString(), expires_at: '2100-01-01' }); },
    } });
    await invoke({ ...REQ, input }, services, OPTS);
    const key = [...stored.keys()][0]!;
    expect(key).toMatch(new RegExp(`^${CONN.id}:${CAP.id}:[a-f0-9]{64}$`));
    expect(key).not.toContain(input.password);
    expect(key).not.toContain(Buffer.from(JSON.stringify(input)).toString('base64url'));
    await invoke({ ...REQ, input: { amount: input.amount, post: input.post, contact: input.contact, password: input.password,
      'unlisted-private-key@example.test': 'private unclassified value' } }, services, OPTS);
    const entries = append.mock.calls.map(([entry]) => entry as { action: string; detail: { input_summary: { sha256: string; fields: string[]; additional_field_count: number } } });
    expect(entries.map((entry) => entry.action)).toEqual([`${CAP.id}:success`, `${CAP.id}:cache_hit`]);
    expect(entries[0]!.detail.input_summary).toEqual(entries[1]!.detail.input_summary);
    expect(entries[0]!.detail.input_summary).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      fields: ['amount', 'contact', 'password', 'post'], field_count: 5, additional_field_count: 1 });
    expect(services.dispatch.dispatch).toHaveBeenCalledOnce();
    const auditText = JSON.stringify(entries);
    for (const secret of [...Object.values(input).filter((value) => typeof value === 'string'), input.contact.email,
      String(input.amount), 'unlisted-private-key@example.test']) expect(auditText).not.toContain(secret);
    await invoke({ ...REQ, input: { ...input, post: 'another private draft' } }, services, OPTS);
    expect(append.mock.calls[2]![0].detail.input_summary.sha256).not.toBe(entries[0]!.detail.input_summary.sha256);
  });
});

describe('invoke() trusted admin caller', () => {
  const admin = { kind: 'admin', user_id: 'admin-user' } as const;

  it('uses the common dispatch and audit pipeline without issuing an admin token', async () => {
    const svc = makeServices({ auth: { getClient: () => undefined, getGrants: () => [] } });
    const { token: _token, ...request } = REQ;
    const env = await invoke(request, svc, OPTS, admin);
    expect(env.data).toEqual({ balance: 42 });
    expect(svc.audit.append).toHaveBeenCalledWith(expect.objectContaining({
      client_id: undefined,
      detail: expect.objectContaining({ actor: admin }),
    }));
  });

  it('does not trust caller data embedded in a request', async () => {
    const request = { ...REQ, token: 'bad-token', caller: admin };
    const env = await invoke(request, makeServices(), OPTS);
    expect(env.error?.code).toBe('UNAUTHENTICATED');
  });

  it('keeps all action capabilities disabled even for an admin verification', async () => {
    const svc = makeServices({ capabilities: { get: () => ({ ...CAP, kind: 'action' }) } });
    const env = await invoke(REQ, svc, OPTS, { ...admin, verify: true });
    expect(env.error?.code).toBe('CAPABILITY_DISABLED');
    expect(svc.dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('allows only an explicit admin verification to probe a needs_auth capability', async () => {
    const svc = makeServices({
      connections: { get: () => ({ ...CONN, capability_states: { [CAP.id]: { status: 'needs_auth' } } }) },
    });
    expect((await invoke(REQ, svc, OPTS, admin)).error?.code).toBe('AUTH_EXPIRED');
    expect((await invoke(REQ, svc, OPTS, { ...admin, verify: true })).outcome).toBe('success');
    expect(svc.cache.set).not.toHaveBeenCalled();
  });

  it('does not allow verification to bypass disabled capability state', async () => {
    const svc = makeServices({
      connections: { get: () => ({ ...CONN, capability_states: { [CAP.id]: { status: 'disabled' } } }) },
    });
    expect((await invoke(REQ, svc, OPTS, { ...admin, verify: true })).error?.code).toBe('CAPABILITY_DISABLED');
  });
});

describe('invoke() schema enforcement and current policy', () => {
  it('rejects malformed parameters before dispatching', async () => {
    const svc = makeServices({ capabilities: { get: () => ({ ...CAP, input: {
      type: 'object', properties: { limit: { type: 'integer', minimum: 1 } }, required: ['limit'], additionalProperties: false,
    } }) } });
    const env = await invoke({ ...REQ, input: { limit: '20' } }, svc, OPTS);
    expect(env.error?.code).toBe('INVALID_PARAMS');
    expect(svc.dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('rejects upstream data that violates the output schema instead of caching success', async () => {
    const svc = makeServices();
    vi.mocked(svc.dispatch.dispatch).mockResolvedValueOnce({
      status: 'ok', outcome: 'success', data: { balance: 'not-a-number' }, error: null, fields: {},
      source: { connection_id: CONN.id, connection_label: CONN.label, capability_id: CAP.id, support: CAP.support },
      data_time: '2026-11-02', queried_at: '2026-11-02', cache: null, warnings: [],
    });
    const env = await invoke(REQ, svc, OPTS);
    expect(env.error?.code).toBe('PARSE_FAILED');
    expect(env.data).toBeNull();
    expect(svc.cache.set).not.toHaveBeenCalled();
  });

  it('refuses a capability that still needs an adapter', async () => {
    const svc = makeServices({ capabilities: { get: () => ({ ...CAP, support: { status: 'needs_adapter' } }) } });
    expect((await invoke(REQ, svc, OPTS)).error?.code).toBe('CAPABILITY_UNSUPPORTED');
    expect(svc.dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('stores raw output and filters again when a different client reads the shared cache', async () => {
    const svc = makeServices();
    let stored: import('../src/invoke/index.js').CachedResult | undefined;
    svc.cache = {
      get: async () => stored,
      set: async (_key, envelope, ttl) => { stored = { envelope, ttl, cached_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() }; },
      invalidate: () => {},
    };
    const opts: InvokeOptions = { ...OPTS, redactOutput: (data, _cap, _audience, _client, grant) => grant?.visibility?.financial === false ? { balance: null } : data };
    const first = await invoke(REQ, svc, opts);
    expect(first.data).toEqual({ balance: 42 });
    expect(stored?.envelope.data).toEqual({ balance: 42 });
    svc.auth.getClient = () => ({ ...CLIENT, id: 'restricted-client' });
    svc.auth.getGrants = () => [{ ...GRANT, client_id: 'restricted-client', visibility: { financial: false } }];
    const second = await invoke(REQ, svc, opts);
    expect(second.cache?.hit).toBe(true);
    expect(second.data).toEqual({ balance: null });
    expect(second.fields['balance']?.status).toBe('redacted');
    expect(stored?.envelope.data).toEqual({ balance: 42 });
    expect(svc.dispatch.dispatch).toHaveBeenCalledOnce();
  });

  it('rechecks revocation after an asynchronous upstream call', async () => {
    const svc = makeServices();
    const normal = vi.mocked(svc.dispatch.dispatch).getMockImplementation()!;
    svc.dispatch.dispatch = vi.fn(async (...args: Parameters<InvokeServices['dispatch']['dispatch']>) => {
      const result = await normal(...args);
      svc.auth.getClient = () => ({ ...CLIENT, revoked: true });
      return result;
    });
    expect((await invoke(REQ, svc, OPTS)).error?.code).toBe('CLIENT_REVOKED');
    expect(svc.cache.set).not.toHaveBeenCalled();
  });

  it('does not return a result from a connection whose credentials/settings changed in flight', async () => {
    let current = { ...CONN };
    const svc = makeServices({ connections: { get: () => current } });
    const execute = vi.mocked(svc.dispatch.dispatch).getMockImplementation()!;
    svc.dispatch.dispatch = vi.fn(async (...args: Parameters<InvokeServices['dispatch']['dispatch']>) => {
      const result = await execute(...args);
      current = { ...current, updated_at: '2026-11-02T12:00:00Z' };
      return result;
    });
    const env = await invoke(REQ, svc, OPTS);
    expect(env.error?.code).toBe('GRANT_REVOKED');
    expect(env.data).toBeNull();
    expect(svc.cache.set).not.toHaveBeenCalled();
  });

  it('does not reuse cache entries after a connector upgrade or connection update', async () => {
    const stored = new Map<string, import('../src/invoke/index.js').CachedResult>();
    let version = '1.0.0';
    let current = { ...CONN };
    const svc = makeServices({ connections: { get: () => current } });
    svc.capabilities.version = () => version;
    svc.cache = {
      get: (key) => stored.get(key),
      set: (key, envelope, ttl) => { stored.set(key, { envelope, ttl, cached_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() }); },
      invalidate: () => {},
    };
    await invoke(REQ, svc, OPTS);
    expect((await invoke(REQ, svc, OPTS)).cache?.hit).toBe(true);
    version = '2.0.0';
    await invoke(REQ, svc, OPTS);
    current = { ...current, updated_at: '2026-11-02T12:00:00Z' };
    await invoke(REQ, svc, OPTS);
    expect(svc.dispatch.dispatch).toHaveBeenCalledTimes(3);
  });
});

describe('invoke() scheduling', () => {
  it('merges concurrent calls with the same normalized parameters', async () => {
    const svc = makeServices();
    const execute = vi.mocked(svc.dispatch.dispatch).getMockImplementation()!;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    svc.dispatch.dispatch = vi.fn(async (...args: Parameters<InvokeServices['dispatch']['dispatch']>) => { started(); await gate; return execute(...args); });
    const one = invoke({ ...REQ, input: { z: 1, a: 2 } }, svc, OPTS);
    const two = invoke({ ...REQ, input: { a: 2, z: 1 } }, svc, OPTS);
    await entered;
    await new Promise((resolve) => setImmediate(resolve));
    expect(svc.dispatch.dispatch).toHaveBeenCalledOnce();
    release();
    const results = await Promise.all([one, two]);
    expect(results.map((r) => r.data)).toEqual([{ balance: 42 }, { balance: 42 }]);
    expect(svc.audit.append).toHaveBeenCalledTimes(2);
  });

  it('serializes different calls to one connection without merging them', async () => {
    const svc = makeServices();
    const execute = vi.mocked(svc.dispatch.dispatch).getMockImplementation()!;
    let release!: () => void;
    let started!: () => void;
    let active = 0;
    let maxActive = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    svc.dispatch.dispatch = vi.fn(async (...args: Parameters<InvokeServices['dispatch']['dispatch']>) => {
      active++;
      maxActive = Math.max(active, maxActive);
      started();
      await gate;
      active--;
      return execute(...args);
    });
    const one = invoke({ ...REQ, input: { page: 1 } }, svc, OPTS);
    const two = invoke({ ...REQ, input: { page: 2 } }, svc, OPTS);
    await entered;
    await new Promise((resolve) => setImmediate(resolve));
    expect(svc.dispatch.dispatch).toHaveBeenCalledOnce();
    release();
    await Promise.all([one, two]);
    expect(svc.dispatch.dispatch).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });
});

describe('invoke() revocation at the final asynchronous boundaries', () => {
  function raceServices(outcome: 'success' | 'partial' = 'success') {
    const state = { revoked: false, granted: true, connection: { ...CONN } };
    const raw: ResultEnvelope = {
      status: outcome === 'partial' ? 'partial' : 'ok', outcome, data: { balance: 42 },
      error: outcome === 'partial' ? { code: 'ITEM_PARSE_FAILED', message: 'Some history is unavailable', retryable: false } : null,
      fields: {}, source: { connection_id: CONN.id, connection_label: CONN.label, capability_id: CAP.id, support: CAP.support },
      queried_at: '2026-11-02T00:00:00Z', data_time: '2026-11-02T00:00:00Z', cache: null, warnings: [],
    };
    const services = makeServices({
      connections: { get: () => state.connection },
      auth: {
        getClient: (hash) => hash === 'hash-good' ? { ...CLIENT, revoked: state.revoked } : undefined,
        getGrants: () => state.granted ? [GRANT] : [],
      },
      dispatch: { dispatch: vi.fn(async () => structuredClone(raw)) },
    });
    const change = (what: 'client' | 'grant' | 'connection') => {
      if (what === 'client') state.revoked = true;
      else if (what === 'grant') state.granted = false;
      else state.connection = { ...state.connection, updated_at: '2026-11-02T12:00:00Z' };
    };
    return { services, raw, change };
  }

  const changes = [
    { what: 'client', code: 'CLIENT_REVOKED' },
    { what: 'grant', code: 'PERMISSION_DENIED' },
    { what: 'connection', code: 'GRANT_REVOKED' },
  ] as const;
  const writeCases = (['success', 'partial'] as const).flatMap((outcome) =>
    (['audit', 'cache'] as const).flatMap((stage) => changes.map((change) => ({ outcome, stage, ...change }))),
  );

  it.each(writeCases)('does not return $outcome data when $what changes during the $stage write', async ({ outcome, stage, what, code }) => {
    const { services, change } = raceServices(outcome);
    const write = vi.fn(async () => { await Promise.resolve(); change(what); });
    if (stage === 'cache') services.cache.set = write;
    else services.audit.append = vi.fn(async (entry) => {
      if (entry.action === `${CAP.id}:${outcome}`) await write();
    });

    const result = await invoke(REQ, services, OPTS);

    expect(write).toHaveBeenCalledOnce();
    expect(services.dispatch.dispatch).toHaveBeenCalledOnce();
    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe(code);
    expect(result.data).toBeNull();
  });

  const readCases = (['success', 'partial'] as const).flatMap((outcome) => changes.map((change) => ({ outcome, ...change })));
  it.each(readCases)('does not return cached $outcome data when $what changes during cache-hit audit', async ({ outcome, what, code }) => {
    const { services, raw, change } = raceServices(outcome);
    services.cache.get = vi.fn(async () => ({
      envelope: raw, cached_at: '2026-11-02T00:00:00Z', expires_at: new Date(Date.now() + 60000).toISOString(), ttl: 60,
    }));
    const auditHit = vi.fn(async () => { await Promise.resolve(); change(what); });
    services.audit.append = vi.fn(async (entry) => {
      if (entry.action === `${CAP.id}:cache_hit`) await auditHit();
    });

    const result = await invoke(REQ, services, OPTS);

    expect(auditHit).toHaveBeenCalledOnce();
    expect(services.dispatch.dispatch).not.toHaveBeenCalled();
    expect(result.error?.code).toBe(code);
    expect(result.data).toBeNull();
  });

  const verificationCases = (['success', 'partial'] as const).flatMap((outcome) =>
    (['execution', 'audit'] as const).map((stage) => ({ outcome, stage })),
  );
  it.each(verificationCases)('does not accept an admin verification $outcome when settings change during $stage', async ({ outcome, stage }) => {
    const { services, raw, change } = raceServices(outcome);
    const updateSettings = vi.fn(async () => { await Promise.resolve(); change('connection'); });
    if (stage === 'execution') services.dispatch.dispatch = vi.fn(async () => { await updateSettings(); return raw; });
    else services.audit.append = vi.fn(async (entry) => {
      if (entry.action === `${CAP.id}:${outcome}`) await updateSettings();
    });

    const result = await invoke(REQ, services, OPTS, { kind: 'admin', user_id: 'admin-user', verify: true });

    expect(updateSettings).toHaveBeenCalledOnce();
    expect(result.error?.code).toBe('GRANT_REVOKED');
    expect(result.data).toBeNull();
    expect(services.cache.set).not.toHaveBeenCalled();
  });

  it('preserves an upstream authentication error when its state update changes the revision', async () => {
    const { services, raw, change } = raceServices();
    services.dispatch.dispatch = vi.fn(async (): Promise<ResultEnvelope> => {
      await Promise.resolve();
      change('connection');
      return { ...raw, status: 'needs_reauth', outcome: 'error', data: null, error: { code: 'AUTH_EXPIRED', message: 'Site session expired', retryable: false } };
    });

    const result = await invoke(REQ, services, OPTS, { kind: 'admin', user_id: 'admin-user', verify: true });

    expect(result.error?.code).toBe('AUTH_EXPIRED');
    expect(result.data).toBeNull();
  });
});

describe('trusted durable callers and dispatch-time authorization', () => {
  it('lets an admin verify an upgraded plan while leaving disabled capabilities closed', async () => {
    const planServices = makeServices({ connections: { get: () => ({ ...CONN, capability_states: { [CAP.id]: { status: 'needs_plan' } } }) } });
    expect((await invoke(REQ, planServices, OPTS, { kind: 'admin', user_id: 'admin', verify: true })).outcome).toBe('success');
    const disabledServices = makeServices({ connections: { get: () => ({ ...CONN, capability_states: { [CAP.id]: { status: 'disabled' } } }) } });
    expect((await invoke(REQ, disabledServices, OPTS, { kind: 'admin', user_id: 'admin', verify: true })).error?.code).toBe('CAPABILITY_DISABLED');
  });
  it('resolves a trusted client by ID without persisting or requiring a token', async () => {
    const services = makeServices();
    services.auth.getClientById = (id) => id === CLIENT.id ? CLIENT : undefined;
    const result = await invoke({ connection_id: CONN.id, capability_id: CAP.id, input: {} },
      services, OPTS, { kind: 'client', client_id: CLIENT.id });
    expect(result.outcome).toBe('success');
    expect(services.dispatch.dispatch).toHaveBeenCalledTimes(1);
  });

  it('checks a trusted client revocation through its current ID lookup', async () => {
    const services = makeServices();
    services.auth.getClientById = () => ({ ...CLIENT, revoked: true });
    const result = await invoke(REQ, services, OPTS, { kind: 'client', client_id: CLIENT.id });
    expect(result.error?.code).toBe('CLIENT_REVOKED');
    expect(services.dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('does not trust a client_id or admin caller smuggled in request input', async () => {
    const services = makeServices();
    services.auth.getClientById = () => CLIENT;
    const forged = { ...REQ, token: 'invalid', client_id: CLIENT.id, caller: { kind: 'admin', user_id: 'root' } };
    const result = await invoke(forged, services, OPTS);
    expect(result.error?.code).toBe('UNAUTHENTICATED');
    expect(services.dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('blocks paused connections for both trusted admin and token clients', async () => {
    const services = makeServices({ connections: { get: () => ({ ...CONN, paused: true }) } });
    expect((await invoke(REQ, services, OPTS)).error?.code).toBe('CAPABILITY_DISABLED');
    expect((await invoke(REQ, services, OPTS, { kind: 'admin', user_id: 'admin' })).error?.code).toBe('CAPABILITY_DISABLED');
    expect(services.dispatch.dispatch).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'paused', 'cancelled'] as const)('rechecks %s after waiting in the connection queue', async (change) => {
    let finish!: (value: ResultEnvelope) => void;
    const blocked = new Promise<ResultEnvelope>((resolve) => { finish = resolve; });
    let currentClient = CLIENT;
    let currentConnection = CONN;
    const services = makeServices({
      auth: { getClient: () => currentClient, getGrants: () => [GRANT] },
      connections: { get: () => currentConnection },
    });
    vi.mocked(services.dispatch.dispatch).mockImplementationOnce(() => blocked);
    const first = invoke({ ...REQ, no_cache: true }, services, OPTS);
    await vi.waitFor(() => expect(services.dispatch.dispatch).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const queued = invoke({ ...REQ, input: { distinct: true }, no_cache: true }, services, { ...OPTS, signal: controller.signal });
    if (change === 'revoked') currentClient = { ...CLIENT, revoked: true };
    if (change === 'paused') currentConnection = { ...CONN, paused: true };
    if (change === 'cancelled') controller.abort();
    finish({ status: 'ok', outcome: 'success', data: { balance: 1 }, error: null, fields: {},
      source: { connection_id: CONN.id, connection_label: CONN.label, capability_id: CAP.id, support: CAP.support },
      data_time: new Date().toISOString(), queried_at: new Date().toISOString(), cache: null, warnings: [] });
    await first;
    const result = await queued;
    expect(result.error?.code).toBe(change === 'revoked' ? 'CLIENT_REVOKED' : 'CAPABILITY_DISABLED');
    expect(services.dispatch.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('connection role authorization', () => {
  it('defaults to user and denies admin-only capabilities even for a trusted server admin', async () => {
    const services = makeServices({ capabilities: { get: () => ({ ...CAP, roles: ['admin'] }) } });
    expect((await invoke(REQ, services, OPTS)).error?.code).toBe('PERMISSION_DENIED');
    expect((await invoke(REQ, services, OPTS, { kind: 'admin', user_id: 'server-admin', verify: true })).error?.code).toBe('PERMISSION_DENIED');
    expect(services.dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('allows an explicitly configured admin account and blocks an empty role allowlist', async () => {
    const services = makeServices({ capabilities: { get: () => ({ ...CAP, roles: ['admin'] }) },
      connections: { get: () => ({ ...CONN, config: { role: 'admin' } }) } });
    expect((await invoke(REQ, services, OPTS)).outcome).toBe('success');
    services.capabilities.get = () => ({ ...CAP, roles: [] });
    expect((await invoke(REQ, services, OPTS)).error?.code).toBe('PERMISSION_DENIED');
  });

  it('rechecks the role after an asynchronous cached read', async () => {
    let connection = { ...CONN, config: { role: 'admin' } };
    const services = makeServices({ capabilities: { get: () => ({ ...CAP, roles: ['admin'] }) }, connections: { get: () => connection } });
    services.cache.get = async () => {
      connection = { ...connection, config: { role: 'user' } };
      return { envelope: { status: 'ok', outcome: 'success', data: { balance: 9 }, error: null, fields: {},
        source: { connection_id: CONN.id, connection_label: CONN.label, capability_id: CAP.id, support: CAP.support },
        data_time: new Date().toISOString(), queried_at: new Date().toISOString(), cache: null, warnings: [] },
      cached_at: new Date().toISOString(), expires_at: new Date(Date.now() + 10000).toISOString(), ttl: 10 };
    };
    expect((await invoke(REQ, services, OPTS)).error?.code).toBe('PERMISSION_DENIED');
    expect(services.dispatch.dispatch).not.toHaveBeenCalled();
  });
});

describe('current client expiration and field visibility', () => {
  it.each(['2000-01-01T00:00:00Z', 'invalid-expiration'])('fails closed for expired or malformed expiration %s', async (expires_at) => {
    const services = makeServices({ auth: { getClient: () => ({ ...CLIENT, expires_at }), getGrants: () => [GRANT] } });
    expect((await invoke(REQ, services, OPTS)).error?.code).toBe('UNAUTHENTICATED');
    expect(services.dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('passes the current client and grant to the field policy after execution', async () => {
    const currentClient = { ...CLIENT, expires_at: '2100-01-01T00:00:00Z' };
    const currentGrant = { ...GRANT, visibility: { financial: false } };
    const services = makeServices({ auth: { getClient: () => currentClient, getGrants: () => [currentGrant] } });
    const policy = vi.fn(() => ({ balance: null }));
    let privateResult: ResultEnvelope | undefined;
    const result = await invoke(REQ, services, { ...OPTS, redactOutput: policy, onAuthorizedResult: (raw) => { privateResult = raw; } });
    expect(policy).toHaveBeenCalledWith({ balance: 42 }, CAP, 'client', currentClient, currentGrant);
    expect(result.data).toEqual({ balance: null });
    expect(result.fields['balance']?.status).toBe('redacted');
    expect(privateResult?.data).toEqual({ balance: 42 });
  });

  it('rechecks expiration after an asynchronous audit, before exposing any result', async () => {
    let client = { ...CLIENT, expires_at: '2100-01-01T00:00:00Z' };
    const services = makeServices({ auth: { getClient: () => client, getGrants: () => [GRANT] } });
    services.audit.append = async () => { client = { ...client, expires_at: '2000-01-01' }; };
    expect((await invoke(REQ, services, OPTS)).error?.code).toBe('UNAUTHENTICATED');
  });
});
