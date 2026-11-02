// Capability executor — M1 stub. Real implementations (feed.list etc.) come in M2.

import type { BrowserContext } from 'playwright'
import { detectAuthFailure, type AuthFailure } from '@webridge/browser-runtime'

export interface ExecResult {
  status: 'ok' | 'error'
  data?: unknown
  error?: {
    code: string
    what_happened: string
    next_step: string
    retryable: boolean
  }
  meta?: unknown
}

export async function execCapability(
  context: BrowserContext,
  capability: string,
  params: Record<string, unknown>,
  _deadlineMs: number,
): Promise<ExecResult> {
  // §4.4.3: a login, captcha or risk-control page means needs_auth. Stop here
  // and report it, never return empty data in its place. M2 handlers must run
  // this check again after navigating to the target page.
  const page = context.pages()[0]
  if (page) {
    const failure = await detectAuthFailure(page)
    if (failure) return authFailureResult(failure)
  }

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
    error: {
      code: failure.code,
      what_happened: failure.what_happened,
      next_step: NEXT_STEP[failure.code],
      retryable: false,
    },
    meta: {
      connection_status: failure.code === 'RISK_CONTROL_DETECTED' ? 'paused' : 'needs_auth',
    },
  }
}
