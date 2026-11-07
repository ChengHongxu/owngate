import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { BrowserContext, Page } from 'playwright'
import { detectAuthFailure, signRequest } from '@owngate/browser-runtime'
import { validateImportedCookies, MAX_IMPORTED_COOKIES } from '../src/cookies.js'
import {
  LoginStateTracker,
  MAX_LOGIN_CONDITIONS,
  parseLoginCondition,
  parseLoginConditions,
} from '../src/login-state.js'
import { execCapability } from '../src/exec.js'
import { buildBrowserServer } from '../src/main.js'
import { FakeSessionManager, post, until } from './helpers.js'

// ── Fakes ─────────────────────────────────────────────────────────────────
// Only the members detectAuthFailure / SessionManager touch are implemented.

interface FakePageOpts {
  url?: string
  visible?: string[]
  text?: string
}

function fakePage(opts: FakePageOpts = {}): Page {
  let url = opts.url ?? 'about:blank'
  const visible = new Set(opts.visible ?? [])
  const page = {
    url: () => url,
    close: async () => undefined,
    goto: async (next: string) => {
      url = next
      return null
    },
    locator: (selector: string) => ({
      first: () => ({ isVisible: async () => visible.has(selector) }),
      innerText: async () => (selector === 'body' ? (opts.text ?? '') : ''),
    }),
  }
  return page as unknown as Page
}

interface FakeCookie {
  name: string
  value: string
  domain: string
  path?: string
}

function fakeContext(page: Page, cookies: FakeCookie[] = []): BrowserContext {
  const jar = [...cookies]
  const ctx = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => jar,
    addCookies: async (add: FakeCookie[]) => {
      jar.push(...add)
    },
  }
  return ctx as unknown as BrowserContext
}

// ── detectAuthFailure ─────────────────────────────────────────────────────

describe('detectAuthFailure', () => {
  it.each([
    'https://passport.bilibili.com/login',
    'https://www.zhihu.com/signin?next=%2F',
    'https://x.com/i/flow/login',
    'https://www.xiaohongshu.com/LOGIN',
  ])('flags login URL %s as LOGIN_REQUIRED', async (url) => {
    const failure = await detectAuthFailure(fakePage({ url }))
    expect(failure?.code).toBe('LOGIN_REQUIRED')
  })

  it('ignores login words in the query string', async () => {
    const page = fakePage({ url: 'https://www.zhihu.com/?ref=login&from=signin' })
    expect(await detectAuthFailure(page)).toBeNull()
  })

  it('does not put the query string (possible tokens) in what_happened', async () => {
    const page = fakePage({ url: 'https://passport.bilibili.com/login?token=secret123' })
    const failure = await detectAuthFailure(page)
    expect(failure?.what_happened).not.toContain('secret123')
  })

  it('flags a visible captcha container as CAPTCHA_PRESENT', async () => {
    const page = fakePage({ url: 'https://www.bilibili.com/', visible: ["iframe[src*='captcha']"] })
    expect((await detectAuthFailure(page))?.code).toBe('CAPTCHA_PRESENT')
  })

  it('flags risk-control text as RISK_CONTROL_DETECTED', async () => {
    const page = fakePage({ url: 'https://www.bilibili.com/', text: '检测到异常访问，请稍后再试' })
    expect((await detectAuthFailure(page))?.code).toBe('RISK_CONTROL_DETECTED')
  })

  it('returns null for an ordinary logged-in page', async () => {
    const page = fakePage({ url: 'https://www.bilibili.com/', text: '首页 推荐 动态' })
    expect(await detectAuthFailure(page)).toBeNull()
  })

  it('makes execCapability return an error instead of data', async () => {
    const ctx = fakeContext(fakePage({ url: 'https://passport.bilibili.com/login' }))
    const result = await execCapability(ctx, 'account.profile', {}, 30_000)
    expect(result.status).toBe('error')
    expect(result.data).toBeUndefined()
    expect(result.error?.code).toBe('LOGIN_REQUIRED')
    expect(result.error?.retryable).toBe(false)
  })

  it('opens a page when the context has none instead of skipping the check', async () => {
    const page = fakePage({ url: 'https://passport.bilibili.com/login' })
    let opened = 0
    const ctx = {
      pages: () => [],
      cookies: async () => [],
      newPage: async () => {
        opened++
        return page
      },
    } as unknown as BrowserContext
    const result = await execCapability(ctx, 'account.profile', {}, 30_000)
    expect(opened).toBe(1)
    expect(result.error?.code).toBe('LOGIN_REQUIRED')
  })
})

// ── validateImportedCookies ───────────────────────────────────────────────

describe('validateImportedCookies', () => {
  const good = { name: 'SESSDATA', value: 's3cr3t', domain: '.bilibili.com' }

  it('accepts a minimal cookie and defaults path to /', () => {
    const r = validateImportedCookies([good])
    expect(r).toEqual({ ok: true, cookies: [{ ...good, path: '/' }] })
  })

  it('normalizes sameSite from browser exports', () => {
    const r = validateImportedCookies([
      { ...good, sameSite: 'no_restriction', secure: true },
      { ...good, sameSite: 'lax' },
      { ...good, sameSite: 'unspecified' },
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.cookies.map((c) => c.sameSite)).toEqual(['None', 'Lax', undefined])
  })

  it.each([
    ['not an array', { name: 'x' }],
    ['empty array', []],
    ['empty domain', [{ ...good, domain: '' }]],
    ['missing domain', [{ name: 'a', value: 'b' }]],
    ['empty name', [{ ...good, name: ' ' }]],
    ['empty value', [{ ...good, value: '' }]],
    ['bad path', [{ ...good, path: 'no-slash' }]],
    ['bad expires', [{ ...good, expires: 'tomorrow' }]],
    ['bad sameSite', [{ ...good, sameSite: 'sometimes' }]],
    ['None without secure', [{ ...good, sameSite: 'None' }]],
  ])('rejects %s', (_label, input) => {
    expect(validateImportedCookies(input).ok).toBe(false)
  })

  it(`rejects more than ${MAX_IMPORTED_COOKIES} cookies`, () => {
    const many = Array.from({ length: MAX_IMPORTED_COOKIES + 1 }, (_, i) => ({ ...good, name: `c${i}` }))
    expect(validateImportedCookies(many).ok).toBe(false)
    expect(validateImportedCookies(many.slice(0, MAX_IMPORTED_COOKIES)).ok).toBe(true)
  })

  it('never puts a cookie value in an error message', () => {
    const r = validateImportedCookies([{ ...good, value: 's3cr3t', domain: '' }])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).not.toContain('s3cr3t')
  })
})

describe('parseLoginConditions', () => {
  it('accepts a non-empty array of conditions', () => {
    const r = parseLoginConditions([
      { type: 'cookie', name: 'SESSDATA', domain: '.bilibili.com' },
      { type: 'url_not_contains', pattern: 'passport.' },
    ])
    expect(r.ok && r.conditions).toHaveLength(2)
  })

  it.each([
    ['a single object', { type: 'cookie', name: 'a', domain: '.x.com' }],
    ['an empty array', []],
    ['a bad element', [{ type: 'cookie', name: 'a', domain: '.x.com' }, { type: 'whoami' }]],
    ['too many', Array.from({ length: MAX_LOGIN_CONDITIONS + 1 }, () => ({ type: 'url_not_contains', pattern: 'x' }))],
  ])('rejects %s', (_label, input) => {
    expect(parseLoginConditions(input).ok).toBe(false)
  })
})

describe('parseLoginCondition', () => {
  it('accepts cookie and url_not_contains conditions', () => {
    expect(parseLoginCondition({ type: 'cookie', name: 'SESSDATA', domain: '.bilibili.com' }).ok).toBe(true)
    expect(parseLoginCondition({ type: 'url_not_contains', pattern: '/login' }).ok).toBe(true)
  })

  it('rejects unknown types and empty fields', () => {
    expect(parseLoginCondition({ type: 'whoami' }).ok).toBe(false)
    expect(parseLoginCondition({ type: 'cookie', name: '', domain: '.x.com' }).ok).toBe(false)
    expect(parseLoginCondition(null).ok).toBe(false)
  })
})

// ── LoginStateTracker (state machine) ─────────────────────────────────────

describe('LoginStateTracker', () => {
  it('starts idle', () => {
    expect(new LoginStateTracker().get('c1').status).toBe('idle')
  })

  it('goes pending → success', () => {
    const t = new LoginStateTracker()
    const { attemptId } = t.begin('c1')
    expect(t.get('c1').status).toBe('pending')
    t.settle('c1', attemptId, { success: true, reason: 'cookie found' })
    expect(t.get('c1')).toMatchObject({ status: 'success', reason: 'cookie found' })
  })

  it('goes pending → timeout on failure, never back to idle or empty', () => {
    const t = new LoginStateTracker()
    const { attemptId } = t.begin('c1')
    t.settle('c1', attemptId, { success: false, reason: 'timeout' })
    expect(t.get('c1')).toMatchObject({ status: 'timeout', reason: 'timeout' })
  })

  it('ignores a superseded attempt and aborts it', () => {
    const t = new LoginStateTracker()
    const first = t.begin('c1')
    const second = t.begin('c1')
    expect(first.signal.aborted).toBe(true)
    t.settle('c1', first.attemptId, { success: false, reason: 'aborted' })
    expect(t.get('c1').status).toBe('pending')
    t.settle('c1', second.attemptId, { success: true, reason: 'ok' })
    expect(t.get('c1').status).toBe('success')
  })

  it('stop turns pending into idle but keeps a settled result', () => {
    const t = new LoginStateTracker()
    const a = t.begin('c1')
    t.stop('c1')
    expect(a.signal.aborted).toBe(true)
    expect(t.get('c1').status).toBe('idle')
    t.settle('c1', a.attemptId, { success: false, reason: 'aborted' })
    expect(t.get('c1').status).toBe('idle')

    const b = t.begin('c2')
    t.settle('c2', b.attemptId, { success: true, reason: 'ok' })
    t.stop('c2')
    expect(t.get('c2').status).toBe('success')
  })

  it('markSuccess ends a pending wait; clear resets to idle', () => {
    const t = new LoginStateTracker()
    const a = t.begin('c1')
    t.markSuccess('c1', 'cookie import verified')
    expect(a.signal.aborted).toBe(true)
    expect(t.get('c1').status).toBe('success')
    t.clear('c1')
    expect(t.get('c1').status).toBe('idle')
  })

  it('stamps since with the transition time', () => {
    let now = new Date('2026-11-02T00:00:00Z')
    const t = new LoginStateTracker(() => now)
    now = new Date('2026-11-02T00:01:00Z')
    t.begin('c1')
    expect(t.get('c1').since).toBe('2026-11-02T00:01:00.000Z')
  })
})

// ── SessionManager wiring ─────────────────────────────────────────────────

describe('SessionManager login flow', () => {
  const sessdata = [{ type: 'cookie', name: 'SESSDATA', domain: '.bilibili.com' }] as const
  const loginUrl = 'https://passport.bilibili.com/login'

  it('detects login in the background after startLogin', async () => {
    const sm = new FakeSessionManager()
    sm.world.cookiesFor('/profiles-default/c1').push({ name: 'SESSDATA', value: 'v', domain: '.bilibili.com' })
    const { stream_token } = await sm.startLogin('c1', loginUrl, { successWhen: sessdata, deadlineMs: 5_000 })
    expect(stream_token).toMatch(/^[0-9a-f]{64}$/)
    await until(() => sm.getLoginState('c1').status === 'success')
    await sm.closeAll()
  })

  it('succeeds when any one of several conditions holds', async () => {
    const sm = new FakeSessionManager()
    sm.world.redirects[loginUrl] = 'https://www.bilibili.com/'
    await sm.startLogin('c1', loginUrl, {
      successWhen: [...sessdata, { type: 'url_not_contains', pattern: 'passport.' }],
      deadlineMs: 5_000,
    })
    await until(() => sm.getLoginState('c1').status === 'success')
    expect(sm.getLoginState('c1').reason).toBe('url no longer contains passport.')
    await sm.closeAll()
  })

  it('ends in timeout, not idle, when the condition never holds', async () => {
    const sm = new FakeSessionManager()
    await sm.startLogin('c1', loginUrl, { successWhen: sessdata, deadlineMs: 50 })
    expect(sm.getLoginState('c1').status).toBe('pending')
    await until(() => sm.getLoginState('c1').status !== 'pending')
    expect(sm.getLoginState('c1')).toMatchObject({ status: 'timeout', reason: 'timeout' })
    await sm.closeAll()
  })

  it('stopLogin aborts the wait and reports idle', async () => {
    const sm = new FakeSessionManager()
    await sm.startLogin('c1', loginUrl, { successWhen: sessdata, deadlineMs: 60_000 })
    await sm.stopLogin('c1')
    expect(sm.getLoginState('c1').status).toBe('idle')
    await sm.closeAll()
  })

  it('importCookies writes cookies and verifies against the conditions', async () => {
    const sm = new FakeSessionManager()
    const r = await sm.importCookies(
      'c1',
      [{ name: 'SESSDATA', value: 'v', domain: '.bilibili.com', path: '/' }],
      sessdata,
    )
    expect(r).toEqual({ logged_in: true })
    expect(sm.getLoginState('c1').status).toBe('success')
    await sm.closeAll()
  })

  it('importCookies reports logged_in: false when the cookie is not the one needed', async () => {
    const sm = new FakeSessionManager()
    const r = await sm.importCookies(
      'c1',
      [{ name: 'other', value: 'v', domain: '.bilibili.com', path: '/' }],
      sessdata,
    )
    expect(r).toEqual({ logged_in: false })
    expect(sm.getLoginState('c1').status).toBe('idle')
    await sm.closeAll()
  })

  it('importCookies falls back to the conditions of the last startLogin', async () => {
    const sm = new FakeSessionManager()
    await sm.startLogin('c1', loginUrl, { successWhen: sessdata, deadlineMs: 60_000 })
    const r = await sm.importCookies('c1', [{ name: 'SESSDATA', value: 'v', domain: '.bilibili.com', path: '/' }])
    expect(r).toEqual({ logged_in: true })
    await sm.closeAll()
  })
})

// ── HTTP endpoints ────────────────────────────────────────────────────────

describe('login HTTP endpoints', () => {
  const SECRET = 'test-rpc-secret'
  let app: FastifyInstance

  beforeAll(async () => {
    process.env['BROWSER_RPC_SECRET'] = SECRET
    app = (await buildBrowserServer()).app
  })

  afterAll(async () => {
    await app.close()
  })

  it('GET /v1/login/status rejects an unsigned request', async () => {
    const resp = await app.inject({ method: 'GET', url: '/v1/login/status?connection_id=c1' })
    expect(resp.statusCode).toBe(401)
  })

  it('GET /v1/login/status rejects a signature made for another connection', async () => {
    const headers = signRequest('', SECRET, { method: 'GET', path: '/v1/login/status?connection_id=other' })
    const resp = await app.inject({
      method: 'GET',
      url: '/v1/login/status?connection_id=c1',
      headers,
    })
    expect(resp.statusCode).toBe(401)
  })

  it('GET /v1/login/status returns idle for an unknown connection', async () => {
    const url = '/v1/login/status?connection_id=never-seen'
    const resp = await app.inject({ method: 'GET', url, headers: signRequest('', SECRET, { method: 'GET', path: url }) })
    expect(resp.statusCode).toBe(200)
    const body = JSON.parse(resp.body)
    expect(body.status).toBe('idle')
    expect(typeof body.since).toBe('string')
  })

  it('POST /v1/cookies/import rejects invalid cookies without echoing values', async () => {
    const body = {
      connection_id: 'c1',
      cookies: [{ name: 'SESSDATA', value: 'leak-me', domain: '' }],
    }
    const resp = await app.inject({
      method: 'POST',
      url: '/v1/cookies/import',
      headers: { 'content-type': 'application/json', ...signRequest(JSON.stringify(body), SECRET, { method: 'POST', path: '/v1/cookies/import' }) },
      payload: body,
    })
    expect(resp.statusCode).toBe(400)
    expect(JSON.parse(resp.body).code).toBe('INVALID_PARAMS')
    expect(resp.body).not.toContain('leak-me')
  })

  it('POST /v1/login/start requires success_when as a condition array', async () => {
    const base = { connection_id: 'c1', url: 'https://passport.bilibili.com/login' }
    for (const body of [
      base,
      { ...base, success_when: { type: 'cookie', name: 'SESSDATA', domain: '.bilibili.com' } },
      { ...base, success_when: [] },
    ]) {
      const resp = await post(app, '/v1/login/start', body)
      expect(resp.statusCode).toBe(400)
      expect(JSON.parse(resp.body).code).toBe('INVALID_PARAMS')
    }
  })

  it('POST /v1/login/start rejects a non-http url', async () => {
    const resp = await post(app, '/v1/login/start', {
      connection_id: 'c1',
      url: 'file:///etc/passwd',
      success_when: [{ type: 'url_not_contains', pattern: 'login' }],
    })
    expect(resp.statusCode).toBe(400)
  })
})
