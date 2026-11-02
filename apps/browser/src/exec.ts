// Capability executor — M1 stub. Real implementations (feed.list etc.) come in M2.

import type { BrowserContext } from 'playwright'
import { detectAuthFailure, type AuthFailure } from '@webridge/browser-runtime'
import { workerError, type WorkerError } from './errors.js'

export interface ExecResult {
  status: 'ok' | 'error'
  data?: unknown
  /** `code` is always a §6.1 code (design §13.1). */
  error?: WorkerError
  meta?: unknown
}

/**
 * Run one capability in the connection's context. The caller holds the
 * connection lock and a pool lease. `signal` fires at deadline_ms; handlers
 * must stop at the next await when it does (the caller has already answered
 * UPSTREAM_TIMEOUT and keeps the lock until this promise settles).
 */
export async function execCapability(
  context: BrowserContext,
  capability: string,
  params: Record<string, unknown>,
  _deadlineMs: number,
  _signal?: AbortSignal,
): Promise<ExecResult> {
  // §4.4.3: a login, captcha or risk-control page means needs_auth. Stop here
  // and report it, never return empty data in its place. A context without a
  // page (fresh relaunch, all tabs closed) gets one, so the check is never
  // skipped. M2 handlers must run this check again after navigating.
  const page = context.pages()[0] ?? (await context.newPage())
  const failure = await detectAuthFailure(page)
  if (failure) return authFailureResult(failure)

  // M1 stub: return a fixed shape. Real per-capability handlers land in M2.
  return {
    status: 'ok',
    data: {
      capability,
      params,
      executed_at: new Date().toISOString(),
    },
  }
}

const NEXT_STEP: Record<AuthFailure['code'], string> = {
  LOGIN_REQUIRED: 're-login this connection from the admin console',
  CAPTCHA_PRESENT: 'open the remote screen and solve the captcha by hand',
  RISK_CONTROL_DETECTED: 'pause this connection; do not retry, check the account by hand',
}

/** None of these are retryable; risk control also pauses the connection (§4.5). */
export function authFailureResult(failure: AuthFailure): ExecResult {
  return {
    status: 'error',
    error: workerError(failure.code, failure.what_happened, NEXT_STEP[failure.code]),
    meta: {
      connection_status: failure.code === 'RISK_CONTROL_DETECTED' ? 'paused' : 'needs_auth',
    },
  }
}
