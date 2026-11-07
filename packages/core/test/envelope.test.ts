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
    expect(env.status).toBe('ok');
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
    expect(env.fields['used']?.status).toBe('unknown');
  });
});

describe('envelope.fail', () => {
  it('builds an error envelope with null data', () => {
    const env = fail(err('UPSTREAM_ERROR', 'site returned 500'), source);
    expect(env.status).toBe('error');
    expect(env.outcome).toBe('error');
    expect(env.data).toBeNull();
    expect(env.error?.code).toBe('UPSTREAM_ERROR');
    expect(env.error?.retryable).toBe(true);
  });

  it('marks AUTH_EXPIRED as non-retryable needs_reauth', () => {
    const env = fail(err('AUTH_EXPIRED', 'login expired'), source);
    expect(env.status).toBe('needs_reauth');
    expect(env.error?.retryable).toBe(false);
    expect(AUTH_ERRORS.has('AUTH_EXPIRED')).toBe(true);
  });

  it('takes status from the code classification', () => {
    expect(fail(err('PERMISSION_DENIED', 'x'), source).status).toBe('forbidden');
    expect(fail(err('UNAUTHENTICATED', 'x'), source).status).toBe('forbidden');
    expect(fail(err('CAPABILITY_DISABLED', 'x'), source).status).toBe('unsupported');
    expect(fail(err('APPROVAL_REQUIRED', 'x'), source).status).toBe('needs_approval');
    expect(fail(err('OUTCOME_UNKNOWN', 'x'), source).status).toBe('unknown_outcome');
    expect(fail(err('INVALID_PARAMS', 'x'), source).status).toBe('error');
  });
});

describe('envelope.partial', () => {
  it('builds a partial envelope with both data and error', () => {
    const env = partial(
      { balance: 42 },
      err('ITEM_PARSE_FAILED', 'history unavailable'),
      source,
      { fields: { history: { status: 'unavailable' } } },
    );
    expect(env.status).toBe('partial');
    expect(env.outcome).toBe('partial');
    expect(env.data).toEqual({ balance: 42 });
    expect(env.error?.code).toBe('ITEM_PARSE_FAILED');
    expect(env.fields['history']?.status).toBe('unavailable');
  });
});

describe('error retryability', () => {
  it('UPSTREAM_TIMEOUT and UPSTREAM_ERROR are retryable', () => {
    expect(RETRYABLE.has('UPSTREAM_TIMEOUT')).toBe(true);
    expect(RETRYABLE.has('UPSTREAM_ERROR')).toBe(true);
  });

  it('AUTH_EXPIRED and PERMISSION_DENIED are not retryable', () => {
    expect(RETRYABLE.has('AUTH_EXPIRED')).toBe(false);
    expect(RETRYABLE.has('PERMISSION_DENIED')).toBe(false);
  });

  it('CAPABILITY_DISABLED is not retryable', () => {
    expect(RETRYABLE.has('CAPABILITY_DISABLED')).toBe(false);
  });

  it('err() lets the executor decide UPSTREAM_ERROR retryability', () => {
    expect(err('UPSTREAM_ERROR', 'HTTP 503').retryable).toBe(true);
    expect(err('UPSTREAM_ERROR', 'HTTP 503', { retryable: true }).retryable).toBe(true);
    expect(err('UPSTREAM_ERROR', 'HTTP 404', { retryable: false }).retryable).toBe(false);
  });

  it('err() keeps details only when given', () => {
    expect('details' in err('INTERNAL_ERROR', 'x')).toBe(false);
    expect(err('INTERNAL_ERROR', 'x', { details: { a: 1 } }).details).toEqual({ a: 1 });
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
