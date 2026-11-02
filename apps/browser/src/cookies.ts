// Cookie import validation (design §4.4.3 备用方案: 从自己电脑导出 cookie 粘贴导入).
//
// Error messages name the offending index and field only, never a cookie
// value, so a rejected import cannot leak credentials into logs or responses.

import type { BrowserContext } from 'playwright'

export const MAX_IMPORTED_COOKIES = 200

export type ImportedCookie = Parameters<BrowserContext['addCookies']>[0][number]

export type CookieValidation =
  | { ok: true; cookies: ImportedCookie[] }
  | { ok: false; error: string }

const SAME_SITE: Record<string, 'Strict' | 'Lax' | 'None'> = {
  strict: 'Strict',
  lax: 'Lax',
  none: 'None',
  // Chrome extension exports (chrome.cookies API) use this spelling.
  no_restriction: 'None',
}

export function validateImportedCookies(input: unknown): CookieValidation {
  if (!Array.isArray(input)) return { ok: false, error: 'cookies must be an array' }
  if (input.length === 0) return { ok: false, error: 'cookies must not be empty' }
  if (input.length > MAX_IMPORTED_COOKIES) {
    return {
      ok: false,
      error: `too many cookies: ${input.length} > ${MAX_IMPORTED_COOKIES}`,
    }
  }

  const cookies: ImportedCookie[] = []
  for (const [i, raw] of input.entries()) {
    const at = `cookies[${i}]`
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: `${at} must be an object` }
    }
    const c = raw as Record<string, unknown>
    const name = c['name']
    const value = c['value']
    const domain = c['domain']
    const path = c['path']
    const expires = c['expires']
    const httpOnly = c['httpOnly']
    const secure = c['secure']
    const sameSiteRaw = c['sameSite']

    if (typeof name !== 'string' || name.trim() === '') {
      return { ok: false, error: `${at}.name must be a non-empty string` }
    }
    if (typeof value !== 'string' || value === '') {
      return { ok: false, error: `${at}.value must be a non-empty string` }
    }
    if (typeof domain !== 'string' || domain.trim() === '') {
      return { ok: false, error: `${at}.domain must be a non-empty string` }
    }
    if (path !== undefined && (typeof path !== 'string' || !path.startsWith('/'))) {
      return { ok: false, error: `${at}.path must be a string starting with /` }
    }
    if (expires !== undefined && (typeof expires !== 'number' || !Number.isFinite(expires))) {
      return { ok: false, error: `${at}.expires must be a finite number (unix seconds)` }
    }
    if (httpOnly !== undefined && typeof httpOnly !== 'boolean') {
      return { ok: false, error: `${at}.httpOnly must be a boolean` }
    }
    if (secure !== undefined && typeof secure !== 'boolean') {
      return { ok: false, error: `${at}.secure must be a boolean` }
    }

    let sameSite: 'Strict' | 'Lax' | 'None' | undefined
    if (sameSiteRaw !== undefined && sameSiteRaw !== null) {
      if (typeof sameSiteRaw !== 'string') {
        return { ok: false, error: `${at}.sameSite must be Strict, Lax or None` }
      }
      const key = sameSiteRaw.toLowerCase()
      // 'unspecified' (chrome.cookies export) means "browser default": omit it.
      if (key !== 'unspecified') {
        sameSite = SAME_SITE[key]
        if (sameSite === undefined) {
          return { ok: false, error: `${at}.sameSite must be Strict, Lax or None` }
        }
      }
    }
    // Chromium drops SameSite=None cookies that are not Secure; fail loudly instead.
    if (sameSite === 'None' && secure !== true) {
      return { ok: false, error: `${at}: sameSite None requires secure: true` }
    }

    cookies.push({
      name,
      value,
      domain: domain.trim(),
      // Playwright needs either url or domain+path; default the path.
      path: path ?? '/',
      ...(expires !== undefined ? { expires } : {}),
      ...(httpOnly !== undefined ? { httpOnly } : {}),
      ...(secure !== undefined ? { secure } : {}),
      ...(sameSite !== undefined ? { sameSite } : {}),
    })
  }
  return { ok: true, cookies }
}
