// Login detection for the browser-driven login flow (design doc §4.4).

import type { BrowserContext } from 'playwright'

export type LoginCondition =
  | { type: 'cookie'; name: string; domain: string }
  | { type: 'url_not_contains'; pattern: string }

export interface LoginCheckConfig {
  success_when: LoginCondition
  /** capability id to call after detecting login */
  whoami?: string
}

export interface LoginResult {
  success: boolean
  reason: string
}

const POLL_INTERVAL_MS = 2_000

/**
 * Probe the success condition once. Returns the success result, or null when
 * the condition does not hold yet. Used by waitForLogin and by cookie import,
 * which needs a single check right after writing cookies.
 */
export async function checkLoginOnce(
  context: BrowserContext,
  condition: LoginCondition,
): Promise<LoginResult | null> {
  if (condition.type === 'cookie') {
    const cookies = await context.cookies()
    const matched = cookies.some(
      (c) => c.name === condition.name && c.domain === condition.domain,
    )
    return matched ? { success: true, reason: 'cookie found' } : null
  }

  // url_not_contains: only real web pages count. A fresh context sits on
  // about:blank, which trivially "does not contain" any pattern and would
  // otherwise report success before the login page has even loaded.
  for (const page of context.pages()) {
    const url = page.url()
    if (!/^https?:\/\//i.test(url)) continue
    if (!url.includes(condition.pattern)) {
      return { success: true, reason: 'url no longer contains pattern' }
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
