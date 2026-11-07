// Tests for the login-state probe scheduler and its admin routes
// (design §4.4.3 登录态维护, §4.5 熔断规则).

import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Connection, SupportState } from '@owngate/core';
import { ProbeScheduler, NEEDS_AUTH_REASON } from '../src/probe/scheduler.js';
import type { ProbeDeps, ProbeAuditEntry, ProbeTarget } from '../src/probe/scheduler.js';
import { registerProbeRoutes } from '../src/routes/probe.js';

const NOW = new Date('2026-11-02T08:00:00.000Z');

function conn(id: string, states: Record<string, SupportState> = {}): Connection {
  return {
    id,
    connector_id: id.startsWith('http') ? 'newapi' : 'bilibili',
    label: id,
    config: {},
    capability_states: states,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

const TARGET: ProbeTarget = {
  whoami: 'account.profile',
  capabilities: ['account.profile', 'feed.home', 'history.list'],
};

function setup(
  connections: Connection[],
  probe: ProbeDeps['probe'],
  overrides: Partial<ProbeDeps> = {},
) {
  const audits: ProbeAuditEntry[] = [];
  const rawRun = vi.fn(async (_sql: string, _values?: unknown[]) => ({ changes: 1, lastInsertRowid: 0 }));
  const connectionMap = new Map(connections.map((c) => [c.id, c]));
  let sequence = 0;
  const deps: ProbeDeps = {
    db: { rawRun } as unknown as ProbeDeps['db'],
    connectionMap,
    probe,
    resolveTarget: (c) => (c.connector_id === 'bilibili' ? TARGET : undefined),
    audit: (e) => { audits.push(e); },
    nextSequence: () => ++sequence,
    now: () => NOW,
    ...overrides,
  };
  return { scheduler: new ProbeScheduler(deps), audits, rawRun, connectionMap };
}

function timeoutError(): Error {
  const e = new Error('The operation was aborted due to timeout');
  e.name = 'TimeoutError';
  return e;
}

describe('ProbeScheduler', () => {
  it('isolates failures: connection A throwing does not stop B from being written back', async () => {
    const { scheduler, rawRun, connectionMap } = setup(
      [conn('a'), conn('b')],
      async (connectionId) => {
        if (connectionId === 'a') throw new Error('browser RPC /v1/probe → 502: boom');
        return { status: 'needs_auth' };
      },
    );

    const results = await scheduler.runOnce();

    expect(results).toEqual([
      { connectionId: 'a', status: 'error', reason: 'browser RPC /v1/probe → 502: boom' },
      { connectionId: 'b', status: 'needs_auth', reason: NEEDS_AUTH_REASON },
    ]);
    expect(rawRun).toHaveBeenCalledTimes(1);
    expect(rawRun.mock.calls[0]?.[1]?.[1]).toBe('b');
    expect(connectionMap.get('a')?.capability_states).toEqual({});
    expect(connectionMap.get('b')?.capability_states['feed.home']?.status).toBe('needs_auth');
  });

  it('a single timeout keeps the previous state and is audited', async () => {
    const before: Record<string, SupportState> = {
      'account.profile': { status: 'supported', probed_at: '2026-11-01T00:00:00.000Z' },
    };
    const { scheduler, audits, rawRun, connectionMap } = setup(
      [conn('a', before)],
      async () => { throw timeoutError(); },
    );

    const [result] = await scheduler.runOnce('a');

    expect(result?.status).toBe('timeout');
    expect(connectionMap.get('a')?.capability_states).toEqual(before);
    expect(rawRun).not.toHaveBeenCalled();
    expect(audits).toEqual([
      { action: 'probe.timeout', target: 'a', detail: { error: 'The operation was aborted due to timeout' } },
    ]);
  });

  it('needs_auth marks every capability and persists via db.rawRun', async () => {
    const { scheduler, audits, rawRun, connectionMap } = setup(
      [conn('a', { 'feed.home': { status: 'supported' } })],
      async () => ({ status: 'needs_auth', reason: 'redirected to passport' }),
    );

    await scheduler.runOnce('a');

    const expected: Record<string, SupportState> = {};
    for (const id of TARGET.capabilities) {
      expected[id] = { status: 'needs_auth', reason: NEEDS_AUTH_REASON, probed_at: NOW.toISOString() };
    }
    const values = rawRun.mock.calls[0]?.[1] as string[];
    expect(JSON.parse(values[0]!)).toEqual(expected);
    expect(values.slice(1)).toEqual(['a', '2026-01-01T00:00:00.000Z', JSON.stringify({ 'feed.home': { status: 'supported' } })]);
    expect(connectionMap.get('a')?.capability_states).toEqual(expected);
    expect(connectionMap.get('a')?.updated_at).toBe('2026-01-01T00:00:00.000Z');
    expect(audits[0]?.action).toBe('probe.needs_auth');
  });

  it('supported clears earlier needs_auth overrides but keeps unrelated ones', async () => {
    const { scheduler, connectionMap } = setup(
      [conn('a', {
        'feed.home': { status: 'needs_auth', reason: NEEDS_AUTH_REASON },
        'history.list': { status: 'disabled' },
      })],
      async () => ({ status: 'supported' }),
    );

    await scheduler.runOnce('a');

    expect(connectionMap.get('a')?.capability_states).toEqual({
      'history.list': { status: 'disabled' },
      'feed.home': { status: 'unverified' },
      'account.profile': { status: 'supported', probed_at: NOW.toISOString() },
    });
  });

  it('skips non-browser connections without calling the probe', async () => {
    const probe = vi.fn(async () => ({ status: 'supported' }));
    const { scheduler } = setup([conn('http-1')], probe);

    const results = await scheduler.runOnce();

    expect(results).toEqual([
      { connectionId: 'http-1', status: 'skipped', reason: 'not a browser-transport connection' },
    ]);
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not probe paused accounts or write capability states', async () => {
    const connection = conn('a'); connection.paused = true;
    const probe = vi.fn(async () => ({ status: 'supported' }));
    const { scheduler, rawRun } = setup([connection], probe);
    expect(await scheduler.runOnce()).toEqual([{ connectionId: 'a', status: 'skipped', reason: 'connection is paused' }]);
    expect(probe).not.toHaveBeenCalled();
    expect(rawRun).not.toHaveBeenCalled();
  });

  it('keeps disabled capabilities disabled after authentication fails', async () => {
    const connection = conn('a', { 'post.create': { status: 'disabled' }, 'history.list': { status: 'disabled' } });
    const { scheduler, connectionMap } = setup([connection], async () => ({ status: 'needs_auth' }), {
      resolveTarget: () => ({ ...TARGET, capabilities: [...TARGET.capabilities, 'post.create'] }),
    });
    await scheduler.runOnce('a');
    expect(connectionMap.get('a')?.capability_states['post.create']).toEqual({ status: 'disabled' });
    expect(connectionMap.get('a')?.capability_states['history.list']).toEqual({ status: 'disabled' });
    expect(connectionMap.get('a')?.capability_states['account.profile']?.status).toBe('needs_auth');
  });

  it('does not restore an account paused while its probe was in flight', async () => {
    const connection = conn('a', { 'account.profile': { status: 'needs_auth' } });
    const { scheduler, rawRun } = setup([connection], async () => { connection.paused = true; return { status: 'supported' }; });
    expect(await scheduler.runOnce('a')).toEqual([{ connectionId: 'a', status: 'skipped', reason: 'connection is paused' }]);
    expect(connection.capability_states['account.profile']?.status).toBe('needs_auth');
    expect(rawRun).not.toHaveBeenCalled();
  });

  it('does not write an old probe result after configuration changed', async () => {
    const connection = conn('a', { 'account.profile': { status: 'needs_auth' } });
    const { scheduler, rawRun } = setup([connection], async () => {
      connection.updated_at = '2026-02-01T00:00:00.000Z';
      return { status: 'supported' };
    });
    expect(await scheduler.runOnce('a')).toEqual([{ connectionId: 'a', status: 'skipped', reason: 'connection changed while probing' }]);
    expect(connection.capability_states['account.profile']?.status).toBe('needs_auth');
    expect(rawRun).not.toHaveBeenCalled();
  });

  it('does not replace a newer observation with a late authentication failure from a probe', async () => {
    const connection = conn('a');
    const { scheduler, rawRun } = setup([connection], async () => {
      connection.capability_states = { 'account.profile': { status: 'supported', probed_at: NOW.toISOString() } };
      return { status: 'needs_auth' };
    });
    expect((await scheduler.runOnce('a'))[0]?.status).toBe('skipped');
    expect(connection.capability_states['account.profile']?.status).toBe('supported');
    expect(rawRun).not.toHaveBeenCalled();
  });

  it('a failed database revision comparison does not change in-memory observations', async () => {
    const connection = conn('a', { 'account.profile': { status: 'supported' } });
    const { scheduler, rawRun } = setup([connection], async () => ({ status: 'needs_auth' }));
    rawRun.mockResolvedValueOnce({ changes: 0, lastInsertRowid: 0 });
    expect((await scheduler.runOnce('a'))[0]?.status).toBe('skipped');
    expect(connection.capability_states['account.profile']?.status).toBe('supported');
  });

  it('successful auth leaves unknown adapters unverified and preserves actual failures and unsupported queries', async () => {
    const connection = conn('a', {
      'feed.home': { status: 'needs_adapter' },
      'history.list': { status: 'needs_adapter', probed_at: '2026-01-01T00:00:00.000Z', reason: 'Real parse failure' },
      'unsupported.query': { status: 'unsupported' },
    });
    const { scheduler } = setup([connection], async () => ({ status: 'supported' }));
    await scheduler.runOnce('a');
    expect(connection.capability_states['account.profile']?.status).toBe('supported');
    expect(connection.capability_states['feed.home']).toEqual({ status: 'unverified' });
    expect(connection.capability_states['history.list']?.reason).toBe('Real parse failure');
    expect(connection.capability_states['unsupported.query']?.status).toBe('unsupported');
  });

  it('a DB write failure still blocks calls in memory and is audited', async () => {
    const { scheduler, audits, connectionMap, rawRun } = setup(
      [conn('a')],
      async () => ({ status: 'needs_auth' }),
    );
    rawRun.mockRejectedValueOnce(new Error('SQLITE_BUSY'));

    const [result] = await scheduler.runOnce('a');

    expect(result?.status).toBe('needs_auth');
    expect(connectionMap.get('a')?.capability_states['feed.home']?.status).toBe('needs_auth');
    expect(audits.map((a) => a.action)).toEqual(['probe.persist_failed', 'probe.needs_auth']);
  });

  it('start() runs the current period once and does not replay missed ticks', async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn(async () => ({ status: 'supported' }));
      const { scheduler } = setup([conn('a')], probe, { intervalMs: 1000 });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(probe).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(probe).toHaveBeenCalledTimes(2);

      scheduler.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an interval setInterval cannot represent', () => {
    expect(() => setup([], async () => ({ status: 'supported' }), { intervalMs: 0 })).toThrow(RangeError);
  });
});

describe('probe routes', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function build(requireAdmin: () => Promise<boolean> = async () => true) {
    const { scheduler } = setup([conn('a'), conn('b')], async () => ({ status: 'needs_auth' }));
    app = Fastify({ logger: false });
    await registerProbeRoutes(app, { scheduler, requireAdmin });
    await app.ready();
    return app;
  }

  it('POST /admin/probe/:id returns the single result (200)', async () => {
    const a = await build();
    const res = await a.inject({ method: 'POST', url: '/admin/probe/a' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connectionId: 'a', status: 'needs_auth', reason: NEEDS_AUTH_REASON });
  });

  it('POST /admin/probe/:id returns 404 for an unknown connection', async () => {
    const a = await build();
    const res = await a.inject({ method: 'POST', url: '/admin/probe/zzz' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /admin/probe returns an array, then GET status reflects it', async () => {
    const a = await build();
    const run = await a.inject({ method: 'POST', url: '/admin/probe' });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toHaveLength(2);

    const status = await a.inject({ method: 'GET', url: '/admin/probe/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ lastRunAt: NOW.toISOString(), lastResults: run.json() });
  });

  it('GET /admin/probe/status before any run has lastRunAt null', async () => {
    const a = await build(async () => true);
    const res = await a.inject({ method: 'GET', url: '/admin/probe/status' });
    expect(res.json()).toEqual({ lastRunAt: null, lastResults: [] });
  });

  it('returns 401 on every route when requireAdmin returns false', async () => {
    const a = await build(async () => false);
    for (const [method, url] of [['POST', '/admin/probe/a'], ['POST', '/admin/probe'], ['GET', '/admin/probe/status']] as const) {
      const res = await a.inject({ method, url });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'NO_SESSION' });
    }
  });
});
