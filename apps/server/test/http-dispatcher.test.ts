// HTTP dispatcher error codes (design §6.1): site 5xx → UPSTREAM_ERROR
// retryable, 4xx → not retryable; timeouts → UPSTREAM_TIMEOUT; credential
// rejection → AUTH_REJECTED; template errors → INVALID_PARAMS.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Capability, Connection } from '@webridge/core';
import { dispatchHttp } from '../src/dispatchers/http.js';

const CONN: Connection = {
  id: 'conn-1',
  connector_id: 'newapi',
  label: 'Site',
  config: {},
  capability_states: {},
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const CAP: Capability = {
  id: 'account.balance',
  kind: 'query',
  title: 'Balance',
  description: '',
  effect: 'read',
  approval: 'never',
  input: {},
  output: {},
  cache: null,
  long_running: false,
  cancel: 'none',
  idempotency: 'none',
  verify: null,
  transport: 'http',
  support: { status: 'supported' },
};

const HTTP = { base: 'https://site.example/api/balance' };

function respondWith(status: number, body: unknown = {}): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dispatchHttp error codes', () => {
  it.each([500, 502, 503])('site %i → UPSTREAM_ERROR, retryable', async (status) => {
    respondWith(status);
    const env = await dispatchHttp(CONN, CAP, {}, {}, HTTP);
    expect(env.status).toBe('error');
    expect(env.error).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
  });

  it.each([400, 404, 422])('site %i → UPSTREAM_ERROR, not retryable', async (status) => {
    respondWith(status);
    const env = await dispatchHttp(CONN, CAP, {}, {}, HTTP);
    expect(env.error).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: false });
  });

  it('a failed success_when uses the same 5xx / 4xx rule', async () => {
    respondWith(503);
    const e5 = await dispatchHttp(CONN, CAP, {}, {}, HTTP, undefined, 'status == 200');
    expect(e5.error).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });

    respondWith(404);
    const e4 = await dispatchHttp(CONN, CAP, {}, {}, HTTP, undefined, 'status == 200');
    expect(e4.error).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: false });
  });

  it('auth_failed_when → AUTH_REJECTED', async () => {
    respondWith(401);
    const env = await dispatchHttp(CONN, CAP, {}, {}, HTTP, undefined, undefined, 'status == 401');
    expect(env.error).toMatchObject({ code: 'AUTH_REJECTED', retryable: false });
    expect(env.status).toBe('error');
  });

  it('a timeout → UPSTREAM_TIMEOUT', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }));
    const env = await dispatchHttp(CONN, CAP, {}, {}, HTTP);
    expect(env.error).toMatchObject({ code: 'UPSTREAM_TIMEOUT', retryable: true });
  });

  it('a 2xx result is ok', async () => {
    respondWith(200, { balance: 1 });
    const env = await dispatchHttp(CONN, CAP, {}, {}, HTTP);
    expect(env.status).toBe('ok');
    expect(env.data).toEqual({ balance: 1 });
  });
});
