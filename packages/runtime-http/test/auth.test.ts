import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeAuth, signRuntime } from '../src/auth.js';

afterEach(() => vi.useRealTimers());
describe('HTTP runtime authentication', () => {
  it('binds method, path, body and independent secret and consumes a valid nonce exactly once', () => {
    const auth = new RuntimeAuth('fixture-control-secret'), body = '{"read":true}';
    const headers = signRuntime('fixture-control-secret', 'POST', '/v1/execute', body);
    expect(auth.verify(headers, 'GET', '/v1/execute', body)).toBe(false);
    expect(auth.verify(headers, 'POST', '/elsewhere', body)).toBe(false);
    expect(auth.verify(headers, 'POST', '/v1/execute', '{}')).toBe(false);
    expect(new RuntimeAuth('different-control-secret').verify(headers, 'POST', '/v1/execute', body)).toBe(false);
    expect(auth.verify(headers, 'POST', '/v1/execute', body)).toBe(true);
    expect(auth.verify(headers, 'POST', '/v1/execute', body)).toBe(false);
  });
  it('rejects stale, future and malformed signatures without consuming valid requests', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const auth = new RuntimeAuth('fixture-control-secret'), body = '{}';
    const headers = signRuntime('fixture-control-secret', 'POST', '/v1/execute', body);
    vi.advanceTimersByTime(30_001);
    expect(auth.verify(headers, 'POST', '/v1/execute', body)).toBe(false);
    const future = signRuntime('fixture-control-secret', 'POST', '/v1/execute', body);
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    expect(auth.verify(future, 'POST', '/v1/execute', body)).toBe(false);
    for (const signature of ['', '0'.repeat(63), 'z'.repeat(64)]) expect(auth.verify({ ...headers, 'x-og-sig': signature }, 'POST', '/v1/execute', body)).toBe(false);
    expect(auth.verify({ ...headers, 'x-og-ts': ['1', '2'] }, 'POST', '/v1/execute', body)).toBe(false);
  });
});
