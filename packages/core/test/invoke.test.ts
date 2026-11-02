import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '../src/invoke/index.js';
import type {
  InvokeRequest, InvokeServices, InvokeOptions,
  CapabilityRegistry, ConnectionStore, AuthStore,
  CacheStore, AuditStore, Dispatcher,
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
  kind: 'cli',
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

// ── Tests ─────────────────────────────────────────────────────────────────

describe('invoke() auth', () => {
  it('returns UNAUTHORIZED for unknown token', async () => {
    const env = await invoke({ ...REQ, token: 'bad-token' }, makeServices(), OPTS);
    expect(env.outcome).toBe('error');
    expect(env.error?.code).toBe('UNAUTHORIZED');
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

  it('returns FORBIDDEN when no grant for connection', async () => {
    const svc = makeServices({ auth: { getClient: () => CLIENT, getGrants: () => [] } });
    const env = await invoke(REQ, svc, OPTS);
    expect(env.error?.code).toBe('FORBIDDEN');
  });

  it('returns FORBIDDEN when capability not in grant', async () => {
    const svc = makeServices({
      auth: {
        getClient: () => CLIENT,
        getGrants: () => [{ ...GRANT, capabilities: ['other.cap'] }],
      },
    });
    const env = await invoke(REQ, svc, OPTS);
    expect(env.error?.code).toBe('FORBIDDEN');
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
  it('returns NEEDS_AUTH for needs_auth status', async () => {
    const svc = makeServices({
      connections: {
        get: () => ({
          ...CONN,
          capability_states: { 'account.balance': { status: 'needs_auth', reason: 'login expired' } },
        }),
      },
    });
    const env = await invoke(REQ, svc, OPTS);
    expect(env.error?.code).toBe('NEEDS_AUTH');
  });

  it('returns ACTION_DISABLED for action capabilities', async () => {
    const actionCap: Capability = { ...CAP, id: 'post.create', kind: 'action', cache: null };
    const svc = makeServices({
      capabilities: { get: () => actionCap },
      connections: { get: () => ({ ...CONN, capability_states: {} }) },
      auth: {
        getClient: () => CLIENT,
        getGrants: () => [{ ...GRANT, capability_id: 'post.create', capabilities: ['*'] }],
      },
    });
    const env = await invoke({ ...REQ, capability_id: 'post.create' }, svc, OPTS);
    expect(env.error?.code).toBe('ACTION_DISABLED');
  });
});

describe('invoke() cache', () => {
  it('returns cache hit with cache metadata', async () => {
    const cachedEnvelope: ResultEnvelope = {
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
});
