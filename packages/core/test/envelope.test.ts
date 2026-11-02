import { describe, it, expect } from 'vitest';
import { ok, fail, partial, type ResultEnvelope } from '../src/envelope/index.js';
import { err, RETRYABLE, AUTH_ERRORS } from '../src/errors/index.js';
import type { Capability, SupportState } from '../src/types/index.js';

const source = {
  connection_id: 'conn-1',
  connection_label: 'Test Site',
  capability_id: 'account.balance',
  support: { status: 'supported' } as SupportState,
};

describe('envelope.ok', () => {
  it('builds a success envelope with timestamps', () => {
    const env = ok({ balance: 42 }, source);
    expect(env.outcome).toBe('success');
    expect(env.data).toEqual({ balance: 42 });
    expect(env.error).toBeNull();
    expect(env.cache).toBeNull();
    expect(env.warnings).toEqual([]);
    expect(env.data_time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(env.queried_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('preserves field metadata', () => {
    const env = ok(
      { balance: 42, used: null },
      source,
      {
        fields: {
          used: { status: 'unknown', reason: 'site does not provide lifetime usage' },
        },
      },
    );
    expect(env.fields.used?.status).toBe('unknown');
  });
});

describe('envelope.fail', () => {
  it('builds an error envelope with null data', () => {
    const env = fail(err('UPSTREAM_ERROR', 'site returned 500'), source);
    expect(env.outcome).toBe('error');
    expect(env.data).toBeNull();
    expect(env.error?.code).toBe('UPSTREAM_ERROR');
    expect(env.error?.retryable).toBe(true);
  });

  it('marks NEEDS_AUTH as non-retryable', () => {
    const env = fail(err('NEEDS_AUTH', 'login expired'), source);
    expect(env.error?.retryable).toBe(false);
    expect(AUTH_ERRORS.has('NEEDS_AUTH')).toBe(true);
  });
});

describe('envelope.partial', () => {
  it('builds a partial envelope with both data and error', () => {
    const env = partial(
      { balance: 42 },
      err('PARTIAL_DATA', 'history unavailable'),
      source,
      { fields: { history: { status: 'unavailable' } } },
    );
    expect(env.outcome).toBe('partial');
    expect(env.data).toEqual({ balance: 42 });
    expect(env.error?.code).toBe('PARTIAL_DATA');
    expect(env.fields.history?.status).toBe('unavailable');
  });
});

describe('error retryability', () => {
  it('TIMEOUT and UPSTREAM_ERROR are retryable', () => {
    expect(RETRYABLE.has('TIMEOUT')).toBe(true);
    expect(RETRYABLE.has('UPSTREAM_ERROR')).toBe(true);
  });

  it('NEEDS_AUTH and FORBIDDEN are not retryable', () => {
    expect(RETRYABLE.has('NEEDS_AUTH')).toBe(false);
    expect(RETRYABLE.has('FORBIDDEN')).toBe(false);
  });

  it('ACTION_DISABLED is not retryable', () => {
    expect(RETRYABLE.has('ACTION_DISABLED')).toBe(false);
  });
});

describe('Capability type shape', () => {
  it('accepts a valid query capability', () => {
    const cap: Capability = {
      id: 'account.balance',
      kind: 'query',
      title: 'Account Balance',
      description: 'Current balance',
      effect: 'read',
      approval: 'never',
      input: { type: 'object', properties: {} },
      output: { type: 'object', properties: { balance: { type: 'number' } } },
      cache: { ttl: 60 },
      long_running: false,
      cancel: 'none',
      idempotency: 'none',
      verify: null,
      transport: 'http',
      support: { status: 'supported' },
    };
    expect(cap.id).toBe('account.balance');
    expect(cap.cache?.ttl).toBe(60);
  });

  it('action capabilities have null cache', () => {
    const cap: Capability = {
      id: 'post.create',
      kind: 'action',
      title: 'Create Post',
      description: 'Publish a post',
      effect: 'write',
      approval: 'always',
      input: { type: 'object' },
      output: { type: 'object' },
      cache: null,
      long_running: false,
      cancel: 'local_only',
      idempotency: 'verify',
      verify: 'post.get',
      transport: 'browser',
      support: { status: 'disabled' },
    };
    expect(cap.cache).toBeNull();
    expect(cap.support.status).toBe('disabled');
  });
});
