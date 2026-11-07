// Per-connection login status for the remote-login flow (design §4.4.3).
//
// State machine:
//   idle ──begin──▶ pending ──settle(success)──▶ success
//                      │    └─settle(failure)──▶ timeout
//                      └─stop──▶ idle
//   any ──begin──▶ pending (a new attempt supersedes and aborts the old one)
//   any ──markSuccess──▶ success (cookie import that verified)
//   any ──clear──▶ idle
//
// A failed or timed-out wait never reads as success or as "no data": it ends in
// `timeout` with a reason (design: 登录失效显示 needs_auth，不返回空数据).

import type { LoginCondition, LoginResult } from '@owngate/browser-runtime'

export type LoginStatus = 'pending' | 'success' | 'timeout' | 'idle'

export interface LoginStateSnapshot {
  status: LoginStatus
  reason?: string
  /** ISO time of the last transition. */
  since: string
}

interface Attempt {
  id: number
  controller: AbortController
}

export class LoginStateTracker {
  private readonly states = new Map<string, LoginStateSnapshot>()
  private readonly attempts = new Map<string, Attempt>()
  private nextAttemptId = 1
  private readonly startedAt: string

  constructor(private readonly now: () => Date = () => new Date()) {
    this.startedAt = now().toISOString()
  }

  /** Start a wait. Aborts any earlier attempt for the same connection. */
  begin(connectionId: string): { attemptId: number; signal: AbortSignal } {
    this.abortAttempt(connectionId)
    const attempt: Attempt = { id: this.nextAttemptId++, controller: new AbortController() }
    this.attempts.set(connectionId, attempt)
    this.set(connectionId, 'pending', 'waiting for login')
    return { attemptId: attempt.id, signal: attempt.controller.signal }
  }

  /**
   * Record a wait's outcome. Ignored when the attempt was superseded or
   * stopped; returns whether it was recorded.
   */
  settle(connectionId: string, attemptId: number, result: LoginResult): boolean {
    if (this.attempts.get(connectionId)?.id !== attemptId) return false
    this.attempts.delete(connectionId)
    this.set(connectionId, result.success ? 'success' : 'timeout', result.reason)
    return true
  }

  /** A login wait is running for this connection. */
  isPending(connectionId: string): boolean {
    return this.attempts.has(connectionId)
  }

  /** Success observed outside a wait (cookie import). Ends any pending wait. */
  markSuccess(connectionId: string, reason: string): void {
    this.abortAttempt(connectionId)
    this.set(connectionId, 'success', reason)
  }

  /** Login window closed. A pending wait becomes idle; a settled result is kept. */
  stop(connectionId: string): void {
    const pending = this.attempts.has(connectionId)
    this.abortAttempt(connectionId)
    if (pending) this.set(connectionId, 'idle', 'login stopped')
  }

  /** Session closed: forget the result. */
  clear(connectionId: string): void {
    this.abortAttempt(connectionId)
    this.set(connectionId, 'idle', 'session closed')
  }

  clearAll(): void {
    for (const id of Array.from(this.attempts.keys())) this.abortAttempt(id)
    this.states.clear()
  }

  get(connectionId: string): LoginStateSnapshot {
    return this.states.get(connectionId) ?? { status: 'idle', since: this.startedAt }
  }

  private set(connectionId: string, status: LoginStatus, reason: string): void {
    this.states.set(connectionId, { status, reason, since: this.now().toISOString() })
  }

  private abortAttempt(connectionId: string): void {
    const attempt = this.attempts.get(connectionId)
    if (!attempt) return
    this.attempts.delete(connectionId)
    attempt.controller.abort()
  }
}

/** Upper bound on conditions in one success_when; manifests need a handful. */
export const MAX_LOGIN_CONDITIONS = 20

/**
 * Validate a `success_when` from an RPC body: a non-empty array of conditions,
 * any one of which proves login (design §13.1). The server translates the
 * manifest's `any: [...]` form into this array.
 */
export function parseLoginConditions(
  input: unknown,
): { ok: true; conditions: LoginCondition[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'success_when must be an array' }
  if (input.length === 0) return { ok: false, error: 'success_when must not be empty' }
  if (input.length > MAX_LOGIN_CONDITIONS) {
    return { ok: false, error: `success_when has more than ${MAX_LOGIN_CONDITIONS} conditions` }
  }
  const conditions: LoginCondition[] = []
  for (const [i, raw] of input.entries()) {
    const parsed = parseLoginCondition(raw)
    if (!parsed.ok) return { ok: false, error: `success_when[${i}]: ${parsed.error}` }
    conditions.push(parsed.condition)
  }
  return { ok: true, conditions }
}

/** Validate one condition of a `success_when` array. */
export function parseLoginCondition(
  input: unknown,
): { ok: true; condition: LoginCondition } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'condition must be an object' }
  }
  const c = input as Record<string, unknown>
  if (c['type'] === 'cookie') {
    const name = c['name']
    const domain = c['domain']
    if (!isNonEmpty(name) || !isNonEmpty(domain)) {
      return { ok: false, error: 'cookie condition needs non-empty name and domain' }
    }
    return { ok: true, condition: { type: 'cookie', name, domain } }
  }
  if (c['type'] === 'url_not_contains') {
    const pattern = c['pattern']
    if (!isNonEmpty(pattern)) {
      return { ok: false, error: 'url_not_contains condition needs a non-empty pattern' }
    }
    return { ok: true, condition: { type: 'url_not_contains', pattern } }
  }
  return { ok: false, error: "type must be 'cookie' or 'url_not_contains'" }
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}
