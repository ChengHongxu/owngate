import { describe, expect, it, vi } from 'vitest';
import type { Capability, Connection } from '@owngate/core';
import type { BrowserClient, CheckResult } from '../src/browser-client.js';
import { dispatchBrowser } from '../src/dispatchers/browser.js';

const connection: Connection = { id: 'browser-fixture', connector_id: 'bilibili', label: 'Fixture', config: {},
  capability_states: {}, created_at: '2026-11-03', updated_at: '2026-11-03' };
const capability: Capability = { id: 'feed.list', title: 'Feed', description: '', kind: 'query', effect: 'read',
  approval: 'never', input: {}, output: {}, cache: null, long_running: true, cancel: 'none',
  idempotency: 'none', verify: null, transport: 'browser', support: { status: 'supported' } };

async function dispatchError(error: NonNullable<CheckResult['error']>, meta?: unknown) {
  const client = { check: vi.fn<BrowserClient['check']>().mockResolvedValue({ status: 'error', error, meta }) } as unknown as BrowserClient;
  return dispatchBrowser(client, connection, capability, {});
}

describe('browser worker error mapping', () => {
  it('preserves an account cooldown as non-retryable and retains its specific recovery hint', async () => {
    const result = await dispatchError({ code: 'RATE_LIMITED', what_happened: '账号处于本地查询冷却期',
      next_step: '等到冷却结束后再查询', retryable: false });
    expect(result.error).toEqual({ code: 'RATE_LIMITED', message: '账号处于本地查询冷却期', retryable: false,
      details: { next_step: '等到冷却结束后再查询' } });
  });

  it('retains a retryable transient worker failure', async () => {
    const result = await dispatchError({ code: 'UPSTREAM_UNAVAILABLE', what_happened: 'Temporary network failure',
      next_step: 'Retry later', retryable: true });
    expect(result.error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryable: true });
  });

  it.each(['LOGIN_REQUIRED', 'CAPTCHA_PRESENT', 'RISK_CONTROL_DETECTED', 'AUTH_REJECTED'])(
    'does not let a worker make %s automatically retryable', async code => {
      const result = await dispatchError({ code, what_happened: 'Manual account attention is required',
        next_step: 'Inspect this account', retryable: true }, { connection_status: 'paused' });
      expect(result.error).toMatchObject({ code, retryable: false,
        details: { connection_status: 'paused', next_step: 'Inspect this account' } });
    });

  it.each(['NEW_WORKER_ERROR', 'constructor', '__proto__'])(
    'maps unknown code %s to the core internal-error policy', async code => {
      const result = await dispatchError({ code, what_happened: 'Unknown worker failure',
        next_step: 'Unrecognized recovery hint', retryable: false });
      expect(result.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Unknown worker failure', retryable: true });
    });
});
