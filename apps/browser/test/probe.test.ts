// /v1/probe judges login state (design §13.1), not "is a browser running".

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { BrowserContext } from 'playwright'
import { buildBrowserServer } from '../src/main.js'
import type { ExecResult } from '../src/exec.js'
import { workerError } from '../src/errors.js'
import { FakeSessionManager, SECRET, post, sleep } from './helpers.js'

const loginUrl = 'https://passport.bilibili.com/login'
const SESSDATA = { type: 'cookie', name: 'SESSDATA', domain: '.bilibili.com' } as const
const NOT_LOGIN = { type: 'url_not_contains', pattern: 'passport.' } as const
const timing = { settleQuietMs: 10, settleMaxMs: 50 }

function probeBody(extra: Record<string, unknown> = {}) {
  return {
    connection_id: 'c1',
    login_url: loginUrl,
    success_when: [SESSDATA],
    deadline_ms: 5_000,
    ...extra,
  }
}

let toClose: { app: FastifyInstance; sm: FakeSessionManager }[] = []

async function setup(
  opts: { idleTimeoutMs?: number; exec?: (ctx: BrowserContext, cap: string) => Promise<ExecResult> } = {},
) {
  const sm = new FakeSessionManager(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {})
  const { app } = await buildBrowserServer({
    sessionManager: sm,
    probeTiming: timing,
    ...(opts.exec ? { exec: opts.exec } : {}),
  })
  toClose.push({ app, sm })
  return { app, sm }
}

async function probe(app: FastifyInstance, body: Record<string, unknown>) {
  const resp = await post(app, '/v1/probe', body)
  return { statusCode: resp.statusCode, body: JSON.parse(resp.body) as Record<string, unknown> }
}

beforeAll(() => {
  process.env['BROWSER_RPC_SECRET'] = SECRET
})

afterEach(async () => {
  for (const { app, sm } of toClose) {
    await sm.closeAll()
    await app.close()
  }
  toClose = []
})

describe('/v1/probe', () => {
  it('relaunches a reclaimed browser on the same profile and judges by cookie, without navigating', async () => {
    const { app, sm } = await setup({ idleTimeoutMs: 20 })
    await sm.entry('c1')
    sm.world.cookiesFor('/profiles-default/c1').push({ name: 'SESSDATA', value: 'v', domain: '.bilibili.com' })
    await sleep(60)
    expect(sm.getEntry('c1')).toBeUndefined()

    const r = await probe(app, probeBody())
    expect(r.statusCode).toBe(200)
    expect(r.body['status']).toBe('supported')
    expect(sm.world.launched).toHaveLength(2)
    expect(sm.world.launched.map((l) => l.dir)).toEqual(['/profiles-default/c1', '/profiles-default/c1'])
    expect(sm.world.launched[1]?.ctx.page.gotoCalls).toEqual([])
  })

  it('reports needs_auth when no condition holds, and does not navigate for cookie-only conditions', async () => {
    const { app, sm } = await setup()
    const r = await probe(app, probeBody())
    expect(r.body['status']).toBe('needs_auth')
    expect(sm.world.launched[0]?.ctx.page.gotoCalls).toEqual([])
  })

  it('opens login_url for url_not_contains when the cookie check fails; a redirect away means logged in', async () => {
    const { app, sm } = await setup()
    sm.world.redirects[loginUrl] = 'https://www.bilibili.com/'
    const r = await probe(app, probeBody({ success_when: [SESSDATA, NOT_LOGIN] }))
    expect(r.body).toMatchObject({ status: 'supported' })
    expect(sm.world.launched[0]?.ctx.page.gotoCalls).toEqual([loginUrl])
  })

  it('staying on the login page means needs_auth', async () => {
    const { app } = await setup()
    const r = await probe(app, probeBody({ success_when: [NOT_LOGIN] }))
    expect(r.body['status']).toBe('needs_auth')
  })

  it('returns error "login in progress" and does not navigate during a remote login', async () => {
    const { app, sm } = await setup()
    await sm.startLogin('c1', loginUrl, { successWhen: [SESSDATA], deadlineMs: 60_000 })
    sm.world.redirects[loginUrl] = 'https://www.bilibili.com/'
    const r = await probe(app, probeBody({ success_when: [SESSDATA, NOT_LOGIN] }))
    expect(r.body).toEqual({ status: 'error', reason: 'login in progress' })
    // Only the login's own navigation.
    expect(sm.world.launched[0]?.ctx.page.gotoCalls).toEqual([loginUrl])
  })

  it('a login that starts while the probe waits for the lock is not navigated away from', async () => {
    const { app, sm } = await setup()
    await sm.entry('c1')
    sm.world.gotoDelayMs = 50
    // The login navigates under the lock; the probe arrives before it is marked pending.
    const starting = sm.startLogin('c1', loginUrl, { successWhen: [SESSDATA], deadlineMs: 60_000 })
    await sleep(10)
    expect(sm.isLoginInProgress('c1')).toBe(false)
    const probing = probe(app, probeBody({ success_when: [NOT_LOGIN] }))
    await starting
    expect((await probing).body).toEqual({ status: 'error', reason: 'login in progress' })
    expect(sm.world.launched[0]?.ctx.page.gotoCalls).toEqual([loginUrl])
  })

  it('with whoami, success gives the account', async () => {
    const calls: string[] = []
    const { app, sm } = await setup({
      exec: async (_ctx, cap) => {
        calls.push(cap)
        return { status: 'ok', data: { uid: 42 } }
      },
    })
    await sm.importCookies('c1', [{ name: 'SESSDATA', value: 'v', domain: '.bilibili.com', path: '/' }])
    const r = await probe(app, probeBody({ whoami: 'account.profile' }))
    expect(r.body).toEqual({ status: 'supported', account: { uid: 42 } })
    expect(calls).toEqual(['account.profile'])
  })

  it.each([
    ['LOGIN_REQUIRED', /LOGIN_REQUIRED/],
    ['CAPTCHA_PRESENT', /CAPTCHA_PRESENT/],
    ['RISK_CONTROL_DETECTED', /risk control/],
  ] as const)('whoami %s means needs_auth', async (code, reason) => {
    const { app, sm } = await setup({
      exec: async () => ({ status: 'error', error: workerError(code, 'page says so', 'n/a') }),
    })
    await sm.importCookies('c1', [{ name: 'SESSDATA', value: 'v', domain: '.bilibili.com', path: '/' }])
    const r = await probe(app, probeBody({ whoami: 'account.profile' }))
    expect(r.body['status']).toBe('needs_auth')
    expect(r.body['reason']).toMatch(reason)
  })

  it('whoami is not called when no condition holds', async () => {
    let called = false
    const { app } = await setup({
      exec: async () => {
        called = true
        return { status: 'ok' }
      },
    })
    const r = await probe(app, probeBody({ whoami: 'account.profile' }))
    expect(r.body['status']).toBe('needs_auth')
    expect(called).toBe(false)
  })

  it('returns error with a reason when deadline_ms passes, without hanging', async () => {
    const { app, sm } = await setup()
    sm.world.gotoDelayMs = 500
    const t0 = performance.now()
    const r = await probe(app, probeBody({ success_when: [NOT_LOGIN], deadline_ms: 50 }))
    expect(performance.now() - t0).toBeLessThan(1_000)
    expect(r.body['status']).toBe('error')
    expect(String(r.body['reason'])).toMatch(/deadline/)
  })

  it('reports a browser that cannot start as error, not needs_auth', async () => {
    const { app, sm } = await setup()
    sm.world.failLaunch = true
    const r = await probe(app, probeBody())
    expect(r.body['status']).toBe('error')
    expect(String(r.body['reason'])).toMatch(/BROWSER_UNAVAILABLE/)
  })

  it.each([
    ['missing success_when', { success_when: undefined }],
    ['single-object success_when', { success_when: SESSDATA }],
    ['missing deadline_ms', { deadline_ms: undefined }],
    ['non-http login_url', { login_url: 'javascript:alert(1)' }],
    ['empty whoami', { whoami: '' }],
  ])('rejects %s with 400 INVALID_PARAMS', async (_label, extra) => {
    const { app, sm } = await setup()
    const r = await probe(app, probeBody(extra))
    expect(r.statusCode).toBe(400)
    expect(r.body['code']).toBe('INVALID_PARAMS')
    expect(sm.world.launched).toHaveLength(0)
  })
})
