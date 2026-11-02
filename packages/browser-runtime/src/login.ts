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

export async function waitForLogin(
  context: BrowserContext,
  config: LoginCheckConfig,
  timeoutMs: number,
): Promise<LoginResult> {
  const condition = config.success_when
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (condition.type === 'cookie') {
      const cookies = await context.cookies()
      const matched = cookies.some(
        (c) => c.name === condition.name && c.domain === condition.domain,
      )
      if (matched) {
        return { success: true, reason: 'cookie found' }
      }
    } else {
      // url_not_contains
      const pages = context.pages()
      for (const page of pages) {
        const url = page.url()
        if (!url.includes(condition.pattern)) {
          return { success: true, reason: 'url no longer contains pattern' }
        }
      }
    }
    await sleep(POLL_INTERVAL_MS)
  }

  return { success: false, reason: 'timeout' }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
