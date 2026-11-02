// Detect pages that mean the login state is no longer usable (design §4.4.3
// 登录态维护, §4.5 账号风控). Detection only: this module never interacts with
// a captcha or risk-control page, it just reports that one is showing.

import type { Page } from 'playwright'

export type AuthFailureCode = 'LOGIN_REQUIRED' | 'CAPTCHA_PRESENT' | 'RISK_CONTROL_DETECTED'

export interface AuthFailure {
  code: AuthFailureCode
  what_happened: string
}

/** Matched against host + path only, so `?redirect=/login` does not trigger. */
const LOGIN_URL_RE = /login|signin|passport/i

const CAPTCHA_SELECTORS = [
  "iframe[src*='captcha']",
  '.captcha',
  "[class*='captcha']",
  "[class*='verify']",
] as const

const RISK_PHRASES = ['安全验证', '异常访问', '请完成验证'] as const

/** innerText waits for <body>; a page without one should not stall the exec. */
const BODY_TEXT_TIMEOUT_MS = 1_000

/**
 * Checks, cheapest first; the first hit wins:
 * 1. URL host/path looks like a login page → LOGIN_REQUIRED
 * 2. a visible captcha container           → CAPTCHA_PRESENT
 * 3. visible text has a risk-control phrase → RISK_CONTROL_DETECTED
 * Hidden elements and hidden text are ignored, so preloaded captcha widgets
 * or i18n strings in templates do not cause false positives.
 */
export async function detectAuthFailure(page: Page): Promise<AuthFailure | null> {
  const where = hostAndPath(page.url())
  if (LOGIN_URL_RE.test(where)) {
    return { code: 'LOGIN_REQUIRED', what_happened: `page redirected to a login page: ${where}` }
  }

  for (const selector of CAPTCHA_SELECTORS) {
    if (await isVisible(page, selector)) {
      return {
        code: 'CAPTCHA_PRESENT',
        what_happened: `captcha element is showing (${selector}) on ${where}`,
      }
    }
  }

  const text = await bodyText(page)
  const phrase = RISK_PHRASES.find((p) => text.includes(p))
  if (phrase !== undefined) {
    return {
      code: 'RISK_CONTROL_DETECTED',
      what_happened: `risk-control page detected (text "${phrase}") on ${where}`,
    }
  }

  return null
}

/** Host + path, without query or hash: those can carry tokens and false hits. */
function hostAndPath(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`
  } catch {
    return url.split(/[?#]/)[0] ?? ''
  }
}

async function isVisible(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.locator(selector).first().isVisible()
  } catch {
    return false
  }
}

async function bodyText(page: Page): Promise<string> {
  try {
    return await page.locator('body').innerText({ timeout: BODY_TEXT_TIMEOUT_MS })
  } catch {
    return ''
  }
}
