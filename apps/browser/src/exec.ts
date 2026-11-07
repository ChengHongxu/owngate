// Browser capabilities execute against the connection's isolated cookie jar.

import type { BrowserContext } from 'playwright'
import type { ExecutionStep, FieldMeta } from '@owngate/core'
import { captureSocial, SOCIAL_PLATFORMS } from './social/capture.js'
import type { Platform, ItemError } from './social/types.js'
import { type AuthFailure } from '@owngate/browser-runtime'
import { workerError, type WorkerError } from './errors.js'
import type { BrowserDiagnostics } from './diagnostics.js'

export interface ExecResult {
  status: 'ok' | 'error'
  data?: unknown
  /** `code` is always a §6.1 code (design §13.1). */
  error?: WorkerError
  meta?: unknown
  partial?: boolean
  fields?: Record<string, FieldMeta>
  warnings?: string[]
  item_errors?: ItemError[]
  diagnostics?: ExecutionStep[]
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
  deadlineMs: number,
  signal?: AbortSignal,
  connectorId = 'bilibili',
  diagnostics?: BrowserDiagnostics,
): Promise<ExecResult> {
  if (!SOCIAL_PLATFORMS.includes(connectorId as Platform)) {
    return { status: 'error', error: workerError('CAPABILITY_UNSUPPORTED', 'this browser connector has no executor', 'choose a supported connector') }
  }
  return captureSocial(context, connectorId as Platform, capability, params, deadlineMs, signal, {}, diagnostics)
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
