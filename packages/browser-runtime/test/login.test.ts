import { describe, it, expect } from 'vitest'
import type { BrowserContext } from 'playwright'
import { checkLoginOnce, waitForLogin, type LoginCondition } from '../src/login.js'

function ctx(cookies: { name: string; domain: string }[], urls: string[]): BrowserContext {
  let cookieReads = 0
  const c = {
    cookies: async () => {
      cookieReads++
      return cookies
    },
    pages: () => urls.map((u) => ({ url: () => u })),
    get cookieReads() {
      return cookieReads
    },
  }
  return c as unknown as BrowserContext
}

const SESSDATA: LoginCondition = { type: 'cookie', name: 'SESSDATA', domain: '.bilibili.com' }
const NOT_LOGIN: LoginCondition = { type: 'url_not_contains', pattern: 'passport.' }

describe('checkLoginOnce with a condition array', () => {
  it('succeeds when any one condition holds (cookie)', async () => {
    const c = ctx([{ name: 'SESSDATA', domain: '.bilibili.com' }], ['https://passport.bilibili.com/login'])
    expect(await checkLoginOnce(c, [NOT_LOGIN, SESSDATA])).toMatchObject({ success: true })
  })

  it('succeeds when any one condition holds (url)', async () => {
    const c = ctx([], ['https://www.bilibili.com/'])
    const r = await checkLoginOnce(c, [SESSDATA, NOT_LOGIN])
    expect(r).toEqual({ success: true, reason: 'url no longer contains passport.' })
  })

  it('returns null when none holds', async () => {
    const c = ctx([{ name: 'other', domain: '.bilibili.com' }], ['https://passport.bilibili.com/login'])
    expect(await checkLoginOnce(c, [SESSDATA, NOT_LOGIN])).toBeNull()
  })

  it('an empty array never holds', async () => {
    expect(await checkLoginOnce(ctx([], ['https://x.com/']), [])).toBeNull()
  })

  it('ignores about:blank for url_not_contains', async () => {
    expect(await checkLoginOnce(ctx([], ['about:blank']), [NOT_LOGIN])).toBeNull()
  })

  it('checks only the given pages when passed explicitly', async () => {
    const c = ctx([], ['https://www.bilibili.com/'])
    const login = { url: () => 'https://passport.bilibili.com/login' }
    expect(await checkLoginOnce(c, [NOT_LOGIN], [login])).toBeNull()
  })

  it('does not read cookies when there is no cookie condition', async () => {
    const c = ctx([], ['https://www.bilibili.com/'])
    await checkLoginOnce(c, [NOT_LOGIN])
    expect((c as unknown as { cookieReads: number }).cookieReads).toBe(0)
  })
})

describe('waitForLogin', () => {
  it('returns as soon as one of several conditions holds', async () => {
    const c = ctx([{ name: 'SESSDATA', domain: '.bilibili.com' }], [])
    const r = await waitForLogin(c, { success_when: [NOT_LOGIN, SESSDATA] }, 5_000)
    expect(r).toEqual({ success: true, reason: 'cookie SESSDATA found' })
  })

  it('times out when none holds', async () => {
    const r = await waitForLogin(ctx([], []), { success_when: [SESSDATA] }, 30)
    expect(r).toEqual({ success: false, reason: 'timeout' })
  })
})
