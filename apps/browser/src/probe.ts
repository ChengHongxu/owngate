// /v1/probe: is this connection still logged in? (design §4.4.3 登录态维护, §13.1)
//
// It judges the login state, not whether a browser happens to be running: a
// browser closed by idle reclaim is relaunched on the same profile first.
//
// Order, cheapest first:
// 1. cookie conditions: read the context's cookie jar, no navigation;
// 2. only when those fail and a url_not_contains condition exists: open
//    login_url and watch where it settles (a logged-in site redirects away);
// 3. with `whoami`, run that capability; a login/captcha/risk page there
//    means needs_auth, success gives `account`.
// A remote login in progress is never navigated away from.

import type { BrowserContext, Page } from 'playwright'
import {
  checkCookieConditions,
  checkUrlConditions,
  detectAuthFailure,
  type LoginCondition,
} from '@owngate/browser-runtime'
import type { SessionManager } from './session.js'
import type { ExecResult, execCapability } from './exec.js'
import {
  DeadlineExceededError,
  LoginInProgressError,
  classifyError,
  withDeadline,
  type WorkerErrorCode,
} from './errors.js'

export interface ProbeRequest {
  connectionId: string
  loginUrl: string
  successWhen: readonly LoginCondition[]
  whoami?: string
  connectorId?: string
  deadlineMs: number
}

export interface ProbeResponse {
  status: 'supported' | 'needs_auth' | 'error'
  reason?: string
  account?: unknown
  connection_status?: 'paused' | 'needs_auth'
  error_code?: WorkerErrorCode
}

export interface ProbeTiming {
  /** URL unchanged this long after load counts as settled. */
  settleQuietMs?: number
  /** Stop waiting for a redirect after this long. */
  settleMaxMs?: number
}

const DEFAULT_SETTLE_QUIET_MS = 1_000
const DEFAULT_SETTLE_MAX_MS = 5_000
const SETTLE_POLL_MS = 100

/** whoami codes that mean the session is not usable (§6.1 needs_reauth + risk control). */
const NEEDS_AUTH_CODES: ReadonlySet<WorkerErrorCode> = new Set([
  'LOGIN_REQUIRED',
  'CAPTCHA_PRESENT',
  'AUTH_EXPIRED',
  'AUTH_MISSING',
  'AUTH_REJECTED',
  'RISK_CONTROL_DETECTED',
])

export async function probeLoginState(
  sessions: SessionManager,
  exec: typeof execCapability,
  req: ProbeRequest,
  timing: ProbeTiming = {},
): Promise<ProbeResponse> {
  if (sessions.isLoginInProgress(req.connectionId)) {
    return { status: 'error', reason: 'login in progress' }
  }
  const deadlineAt = Date.now() + req.deadlineMs
  try {
    return await withDeadline(req.deadlineMs, (signal) =>
      sessions.withLockedEntry(
        req.connectionId,
        async (entry) => {
          // A login may have started while this probe waited for the lock.
          if (sessions.isLoginInProgress(req.connectionId)) throw new LoginInProgressError()
          return probeLocked(entry.context, exec, req, deadlineAt, signal, timing)
        },
        signal,
      ),
    )
  } catch (e) {
    if (e instanceof LoginInProgressError) return { status: 'error', reason: 'login in progress' }
    if (e instanceof DeadlineExceededError) {
      return { status: 'error', reason: `probe exceeded deadline_ms (${req.deadlineMs} ms)` }
    }
    const code = classifyError(e, 'BROWSER_UNAVAILABLE')
    return { status: 'error', reason: `${code}: ${(e as Error).message}` }
  }
}

async function probeLocked(
  context: BrowserContext,
  exec: typeof execCapability,
  req: ProbeRequest,
  deadlineAt: number,
  signal: AbortSignal,
  timing: ProbeTiming,
): Promise<ProbeResponse> {
  let hit = await checkCookieConditions(context, req.successWhen)

  if (!hit && req.successWhen.some((c) => c.type === 'url_not_contains')) {
    signal.throwIfAborted()
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto(req.loginUrl, { timeout: remaining(deadlineAt), waitUntil: 'load' })
    await settle(page, deadlineAt, signal, timing)
    hit = checkUrlConditions(req.successWhen, [page])
    if (!hit) {
      // Still on the login page. A captcha or risk-control page is worth naming.
      const failure = await detectAuthFailure(page)
      if (failure && failure.code !== 'LOGIN_REQUIRED') {
        return { status: 'needs_auth', reason: `${failure.code}: ${failure.what_happened}` }
      }
    }
  }

  if (!hit) return { status: 'needs_auth', reason: 'no success_when condition holds' }
  if (req.whoami === undefined) return { status: 'supported', reason: hit.reason }

  signal.throwIfAborted()
  const result = await exec(context, req.whoami, {}, remaining(deadlineAt), signal, req.connectorId)
  return fromWhoami(result)
}

function fromWhoami(result: ExecResult): ProbeResponse {
  if (result.status === 'ok') {
    return {
      status: 'supported',
      ...(result.data !== undefined ? { account: result.data } : {}),
    }
  }
  const error = result.error
  if (error && NEEDS_AUTH_CODES.has(error.code)) {
    const reason =
      error.code === 'RISK_CONTROL_DETECTED'
        ? `risk control: ${error.what_happened}`
        : `${error.code}: ${error.what_happened}`
    return { status: 'needs_auth', reason, connection_status: error.code === 'RISK_CONTROL_DETECTED' ? 'paused' : 'needs_auth', error_code: error.code }
  }
  return {
    status: 'error',
    reason: error ? `whoami failed: ${error.code}: ${error.what_happened}` : 'whoami failed',
    ...(error ? { error_code: error.code } : {}),
    ...((result.meta as { connection_status?: string } | undefined)?.connection_status === 'paused' ? { connection_status: 'paused' as const } : {}),
  }
}

/**
 * Wait for the page to come to rest: load, then the URL unchanged for
 * settleQuietMs (client-side redirects happen after load), at most settleMaxMs
 * or until the deadline.
 */
async function settle(
  page: Page,
  deadlineAt: number,
  signal: AbortSignal,
  timing: ProbeTiming,
): Promise<void> {
  const quietMs = timing.settleQuietMs ?? DEFAULT_SETTLE_QUIET_MS
  const stopAt = Math.min(deadlineAt, Date.now() + (timing.settleMaxMs ?? DEFAULT_SETTLE_MAX_MS))
  try {
    await page.waitForLoadState('load', { timeout: Math.max(1, stopAt - Date.now()) })
  } catch {
    // A slow page still has a URL worth looking at.
  }
  let last = page.url()
  let stableSince = Date.now()
  while (Date.now() < stopAt && Date.now() - stableSince < quietMs) {
    signal.throwIfAborted()
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS))
    const now = page.url()
    if (now !== last) {
      last = now
      stableSince = Date.now()
    }
  }
}

function remaining(deadlineAt: number): number {
  return Math.max(1, deadlineAt - Date.now())
}
