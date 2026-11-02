// Idle reclaim vs. work in progress (design §13.1: login wait, screencast and
// execution hold leases and are never cut short by the 10-minute reclaim).

import { describe, it, expect, beforeAll } from 'vitest'
import type { BrowserContext } from 'playwright'
import { signRequest } from '@webridge/browser-runtime'
import { buildBrowserServer } from '../src/main.js'
import type { ExecResult } from '../src/exec.js'
import { FakeSessionManager, SECRET, checkBody, post, sleep, until } from './helpers.js'

const IDLE_MS = 30
const sessdata = [{ type: 'cookie', name: 'SESSDATA', domain: '.bilibili.com' }] as const
const loginUrl = 'https://passport.bilibili.com/login'

beforeAll(() => {
  process.env['BROWSER_RPC_SECRET'] = SECRET
})

describe('leases keep the browser from idle reclaim', () => {
  it('a login wait longer than the idle timeout keeps its browser', async () => {
    const sm = new FakeSessionManager({ idleTimeoutMs: IDLE_MS })
    await sm.startLogin('c1', loginUrl, { successWhen: sessdata, deadlineMs: 60_000 })
    expect(sm.leaseCount('c1')).toBe(1)
    await sleep(IDLE_MS * 4)
    expect(sm.world.launched[0]?.ctx.closed).toBe(false)
    expect(sm.getLoginState('c1').status).toBe('pending')

    // The QR code gets scanned long after the idle timeout would have fired.
    sm.world.cookiesFor('/profiles-default/c1').push({ name: 'SESSDATA', value: 'v', domain: '.bilibili.com' })
    await until(() => sm.getLoginState('c1').status === 'success', 5_000)
    expect(sm.world.launched).toHaveLength(1)

    // Lease released with the wait: the browser now goes idle as usual.
    expect(sm.leaseCount('c1')).toBe(0)
    await until(() => sm.world.launched[0]!.ctx.closed)
    await sm.closeAll()
  })

  it('stopLogin releases the login lease', async () => {
    const sm = new FakeSessionManager({ idleTimeoutMs: IDLE_MS })
    await sm.startLogin('c1', loginUrl, { successWhen: sessdata, deadlineMs: 60_000 })
    await sm.stopLogin('c1')
    await until(() => sm.leaseCount('c1') === 0)
    await until(() => sm.world.launched[0]!.ctx.closed)
  })

  it('a failed navigation does not leak the lease', async () => {
    const sm = new FakeSessionManager()
    const entry = await sm.entry('c1')
    const page = entry.context.pages()[0] as unknown as { goto: () => Promise<never> }
    page.goto = async () => {
      throw new Error('net::ERR_NAME_NOT_RESOLVED')
    }
    await expect(sm.startLogin('c1', loginUrl, { successWhen: sessdata })).rejects.toThrow()
    expect(sm.leaseCount('c1')).toBe(0)
    expect(sm.getLoginState('c1').status).toBe('idle')
    await sm.closeAll()
  })

  it('an open screencast socket holds a lease until it closes; login success closes it', async () => {
    const sm = new FakeSessionManager({ idleTimeoutMs: IDLE_MS })
    const { app } = await buildBrowserServer({ sessionManager: sm })
    try {
      const { stream_token } = await sm.startLogin('c1', loginUrl, {
        successWhen: sessdata,
        deadlineMs: 60_000,
      })
      const path = `/v1/screencast?token=${stream_token}`
      await app.ready()
      // injectWS does not lower-case header names the way Node's parser does.
      const sig = signRequest(path, SECRET)
      const ws = await app.injectWS(path, {
        headers: { 'x-wr-sig': sig['X-Wr-Sig'], 'x-wr-ts': sig['X-Wr-Ts'] },
      })
      const closed = new Promise<number>((r) => ws.on('close', (code: number) => r(code)))
      await until(() => sm.leaseCount('c1') === 2) // login wait + socket
      expect(sm.world.launched[0]?.ctx.page.cdpCommands).toContain('Page.startScreencast')

      await sleep(IDLE_MS * 3)
      expect(sm.world.launched[0]?.ctx.closed).toBe(false)

      sm.world.cookiesFor('/profiles-default/c1').push({ name: 'SESSDATA', value: 'v', domain: '.bilibili.com' })
      expect(await closed).toBe(1000)
      await until(() => sm.leaseCount('c1') === 0)
      await until(() => sm.world.launched[0]!.ctx.closed)
    } finally {
      await sm.closeAll()
      await app.close()
    }
  })

  it('a /v1/check running past the idle timeout is not interrupted', async () => {
    const sm = new FakeSessionManager({ idleTimeoutMs: IDLE_MS })
    let closedDuringExec = false
    const exec = async (ctx: BrowserContext): Promise<ExecResult> => {
      await sleep(IDLE_MS * 4)
      closedDuringExec = (ctx as unknown as { closed: boolean }).closed
      return { status: 'ok', data: 1 }
    }
    const { app } = await buildBrowserServer({ exec, sessionManager: sm })
    try {
      const resp = await post(app, '/v1/check', checkBody('c1'))
      expect(JSON.parse(resp.body)).toEqual({ status: 'ok', data: 1 })
      expect(closedDuringExec).toBe(false)
      expect(sm.world.launched).toHaveLength(1)
    } finally {
      await sm.closeAll()
      await app.close()
    }
  })
})

describe('closing waits for the request holding the lock', () => {
  it('closeSession lets a running /v1/check finish before closing the browser', async () => {
    const sm = new FakeSessionManager()
    let closedDuringExec: boolean | undefined
    const exec = async (ctx: BrowserContext): Promise<ExecResult> => {
      await sleep(60)
      closedDuringExec = (ctx as unknown as { closed: boolean }).closed
      return { status: 'ok' }
    }
    const { app } = await buildBrowserServer({ exec, sessionManager: sm })
    try {
      const checking = post(app, '/v1/check', checkBody('c1'))
      await until(() => sm.world.launched.length === 1)
      await sleep(10)
      await post(app, '/v1/session/close', { connection_id: 'c1' })
      expect(closedDuringExec).toBe(false)
      expect(JSON.parse((await checking).body).status).toBe('ok')
      expect(sm.world.launched[0]?.ctx.closed).toBe(true)
    } finally {
      await sm.closeAll()
      await app.close()
    }
  })

  it('a check queued behind a close runs on a fresh browser, never a closed one', async () => {
    const sm = new FakeSessionManager()
    const seen: boolean[] = []
    const exec = async (ctx: BrowserContext): Promise<ExecResult> => {
      await sleep(30)
      seen.push((ctx as unknown as { closed: boolean }).closed)
      return { status: 'ok' }
    }
    const { app } = await buildBrowserServer({ exec, sessionManager: sm })
    try {
      const first = post(app, '/v1/check', checkBody('c1'))
      await until(() => sm.world.launched.length === 1)
      const closing = sm.closeSession('c1')
      const second = post(app, '/v1/check', checkBody('c1'))
      await Promise.all([first, closing, second])
      expect(seen).toEqual([false, false])
      expect(sm.world.launched).toHaveLength(2)
    } finally {
      await sm.closeAll()
      await app.close()
    }
  })
})
