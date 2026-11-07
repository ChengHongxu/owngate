import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserContext } from 'playwright'
import { execCapability } from '../src/exec.js'
import { FakeContext, FakePage, FakeWorld } from './helpers.js'

function fixture(body: unknown = { code: 0, data: { isLogin: true, mid: 42, uname: 'Fixture user', face: 'https://i0.hdslb.com/fixture.png' } }, status = 200) {
  const world = new FakeWorld()
  const context = new FakeContext([{ name: 'SESSDATA', value: 'fixture', domain: '.bilibili.com' }], world)
  const events = new EventEmitter(), capture = new FakePage(world)
  const close = vi.fn(async () => undefined)
  const goto = vi.fn(async (destination: string) => {
    capture.current = destination
    events.emit('response', { url: () => 'https://api.bilibili.com/x/web-interface/nav', headers: () => ({}), status: () => status, body: async () => Buffer.from(JSON.stringify(body)) })
  })
  Object.assign(capture, { on: events.on.bind(events), off: events.off.bind(events), close, goto })
  const newPage = vi.fn(async () => capture)
  Object.assign(context, { newPage })
  return { context: context as unknown as BrowserContext, page: context.page, newPage, goto, close }
}

describe('B站 account.profile response capture', () => {
  it('reads only the page\'s normal account response in the connection context', async () => {
    const f = fixture()
    const result = await execCapability(f.context, 'account.profile', {}, 1000, undefined, 'bilibili')
    expect(result).toMatchObject({ status: 'ok', data: { uid: 42, nickname: 'Fixture user', face_url: 'https://i0.hdslb.com/fixture.png' } })
    expect(f.goto).toHaveBeenCalledWith('https://www.bilibili.com/', expect.objectContaining({ waitUntil: 'domcontentloaded' }))
    expect(f.close).toHaveBeenCalledOnce()
    expect((f.context as unknown as { request?: unknown }).request).toBeUndefined()
  })

  it('accepts successful QR cookies even if the old login tab is still visible', async () => {
    const f = fixture()
    f.page.current = 'https://passport.bilibili.com/login'
    expect((await execCapability(f.context, 'account.profile', {}, 1000)).status).toBe('ok')
  })

  it.each([
    [{ code: -101 }, 200, 'LOGIN_REQUIRED'],
    [{ code: 0, data: { isLogin: false } }, 200, 'LOGIN_REQUIRED'],
    [{ code: -412 }, 200, 'RISK_CONTROL_DETECTED'],
    [{ code: -352 }, 200, 'RISK_CONTROL_DETECTED'],
    [{}, 401, 'LOGIN_REQUIRED'],
    [{}, 503, 'UPSTREAM_ERROR'],
    [{ code: 0, data: { isLogin: true, mid: 0 } }, 200, 'PARSE_FAILED'],
  ])('rejects an unauthorised, risky or malformed response %#', async (body, status, code) => {
    const f = fixture(body, status)
    const result = await execCapability(f.context, 'account.profile', {}, 1000)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe(code)
    expect(result.data).toBeUndefined()
    expect(f.close).toHaveBeenCalledOnce()
  })

  it('rejects unsupported actions and arbitrary target URLs', async () => {
    const f = fixture()
    expect((await execCapability(f.context, 'post.create', {}, 1000)).error?.code).toBe('CAPABILITY_UNSUPPORTED')
    expect((await execCapability(f.context, 'account.profile', {}, 1000, undefined, 'other')).error?.code).toBe('CAPABILITY_UNSUPPORTED')
    expect((await execCapability(f.context, 'feed.list', { url: 'http://127.0.0.1' }, 1000)).error?.code).toBe('INVALID_PARAMS')
    expect(f.newPage).not.toHaveBeenCalled()
  })

  it('does not issue a site request after cancellation', async () => {
    const f = fixture(), controller = new AbortController()
    controller.abort(new Error('cancelled fixture'))
    await expect(execCapability(f.context, 'account.profile', {}, 1000, controller.signal)).rejects.toThrow('cancelled fixture')
    expect(f.newPage).not.toHaveBeenCalled()
  })
})
