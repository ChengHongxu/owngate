// Login detection for the browser-driven login flow (design doc §4.4).

import type { BrowserContext } from 'playwright'

export type LoginCondition =
  | { type: 'cookie'; name: string; domain: string }
  | { type: 'url_not_contains'; pattern: string }

export interface LoginCheckConfig {
  /** Any one condition holding means logged in (design §13.1). Empty never holds. */
  success_when: readonly LoginCondition[]
  /** capability id to call after detecting login */
  whoami?: string
}

export interface LoginResult {
  success: boolean
  reason: string
}

const POLL_INTERVAL_MS = 2_000

/** Pages (or anything with a url()) whose address url_not_contains looks at. */
export interface UrlSource {
  url(): string
}

/**
 * Probe the success conditions once; any one holding is success. Returns the
 * success result, or null when none holds yet. Cookie conditions are checked
 * first and read only the context's cookie jar. url_not_contains conditions
 * look at `pages`, default every page of the context.
 *
 * Used by waitForLogin, by cookie import (one check right after writing
 * cookies) and by the login-state probe.
 */
export async function checkLoginOnce(
  context: BrowserContext,
  conditions: readonly LoginCondition[],
  pages?: readonly UrlSource[],
): Promise<LoginResult | null> {
  const byCookie = await checkCookieConditions(context, conditions)
  if (byCookie) return byCookie
  return checkUrlConditions(conditions, pages ?? context.pages())
}

/** Cookie conditions only; never navigates. Null when none holds or there are none. */
export async function checkCookieConditions(
  context: BrowserContext,
  conditions: readonly LoginCondition[],
): Promise<LoginResult | null> {
  const wanted = conditions.filter(
    (c): c is Extract<LoginCondition, { type: 'cookie' }> => c.type === 'cookie',
  )
  if (wanted.length === 0) return null
  const cookies = await context.cookies()
  for (const cond of wanted) {
    if (cookies.some((c) => c.name === cond.name && c.domain === cond.domain)) {
      return { success: true, reason: `cookie ${cond.name} found` }
    }
  }
  return null
}

/**
 * url_not_contains conditions against the given pages. Only real web pages
 * count: a fresh context sits on about:blank, which trivially "does not
 * contain" any pattern and would otherwise report success before the login
 * page has even loaded.
 */
export function checkUrlConditions(
  conditions: readonly LoginCondition[],
  pages: readonly UrlSource[],
): LoginResult | null {
  const patterns = conditions.flatMap((c) => (c.type === 'url_not_contains' ? [c.pattern] : []))
  if (patterns.length === 0) return null
  for (const page of pages) {
    const url = page.url()
    if (!/^https?:\/\//i.test(url)) continue
    const missing = patterns.find((p) => !url.includes(p))
    if (missing !== undefined) {
      return { success: true, reason: `url no longer contains ${missing}` }
    }
  }
  return null
}

/**
 * Poll the success condition every 2 s until it holds, the timeout passes, or
 * `signal` aborts. Always probes at least once, and once more at the deadline.
 */
export async function waitForLogin(
  context: BrowserContext,
  config: LoginCheckConfig,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<LoginResult> {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    if (signal?.aborted) return { success: false, reason: 'aborted' }
    const hit = await checkLoginOnce(context, config.success_when)
    if (hit) return hit
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await sleep(Math.min(POLL_INTERVAL_MS, remaining), signal)
  }

  return { success: false, reason: 'timeout' }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}
