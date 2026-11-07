// Worker errors share the canonical client error codes and retry policy.
import { CODE_CLASSIFICATION, type ErrorCode } from '@owngate/core'

export type WorkerErrorCode = ErrorCode

export interface WorkerError {
  code: WorkerErrorCode
  what_happened: string
  next_step: string
  retryable: boolean
}

export function workerError(
  code: WorkerErrorCode,
  whatHappened: string,
  nextStep: string,
): WorkerError {
  return { code, what_happened: whatHappened, next_step: nextStep, retryable: CODE_CLASSIFICATION[code].retryable }
}

/** HTTP status for a worker-level error body. */
export function httpStatusFor(code: WorkerErrorCode): number {
  switch (code) {
    case 'INVALID_PARAMS':
      return 400
    case 'UNAUTHENTICATED':
      return 401
    case 'BROWSER_UNAVAILABLE':
      return 503
    case 'UPSTREAM_TIMEOUT':
      return 504
    default:
      return 500
  }
}

export function invalidParams(whatHappened: string): WorkerError {
  return workerError('INVALID_PARAMS', whatHappened, 'fix the request body')
}

/** The request's deadline_ms passed before the work finished. */
export class DeadlineExceededError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`deadline of ${deadlineMs} ms exceeded`)
    this.name = 'DeadlineExceededError'
  }
}

/** The browser could not be launched or went away mid-request. */
export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserUnavailableError'
  }
}

/** context.addCookies() refused the batch. The message never quotes a cookie. */
export class CookieRejectedError extends Error {
  constructor() {
    super('the browser rejected the cookie batch')
    this.name = 'CookieRejectedError'
  }
}

/** A remote login is running on this connection; navigating would break it. */
export class LoginInProgressError extends Error {
  constructor() {
    super('login in progress')
    this.name = 'LoginInProgressError'
  }
}

/**
 * Run `work` with an AbortSignal that fires at the deadline. Rejects with
 * DeadlineExceededError at the deadline even when `work` ignores the signal;
 * `work` keeps running in the background in that case, and whatever it holds
 * (a lock, a lease) is released only when it settles.
 */
export async function withDeadline<T>(
  deadlineMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new DeadlineExceededError(deadlineMs)
      // signal.throwIfAborted() in the work then throws this same error.
      controller.abort(reason)
      reject(reason)
    }, deadlineMs)
  })
  const running = work(controller.signal)
  // Settled late or not at all: do not leave an unhandled rejection behind.
  running.catch(() => undefined)
  try {
    return await Promise.race([running, expired])
  } finally {
    clearTimeout(timer)
  }
}

/** Largest deadline_ms accepted; also keeps setTimeout below its 2^31-1 ms limit. */
export const MAX_DEADLINE_MS = 15 * 60 * 1000

/**
 * Map an exception to a §6.1 code. `fallback` covers what is left: a failure
 * while driving the browser is BROWSER_UNAVAILABLE, anything else INTERNAL_ERROR.
 */
export function classifyError(
  e: unknown,
  fallback: 'BROWSER_UNAVAILABLE' | 'INTERNAL_ERROR' = 'INTERNAL_ERROR',
): WorkerErrorCode {
  if (e instanceof DeadlineExceededError) return 'UPSTREAM_TIMEOUT'
  if (e instanceof BrowserUnavailableError) return 'BROWSER_UNAVAILABLE'
  if (e instanceof CookieRejectedError) return 'INVALID_PARAMS'
  if (e instanceof Error) {
    if (e.name === 'InvalidConnectionIdError') return 'INVALID_PARAMS'
    // Playwright: navigation or wait timed out.
    if (e.name === 'TimeoutError') return 'UPSTREAM_TIMEOUT'
    // Chromium network errors (DNS, refused, proxy denial).
    if (/net::ERR_/.test(e.message)) return 'UPSTREAM_UNAVAILABLE'
    if (/has been closed|Target closed|browser has disconnected/i.test(e.message)) {
      return 'BROWSER_UNAVAILABLE'
    }
  }
  return fallback
}
