import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildBrowserServer } from '../src/main.js'
import type { execCapability } from '../src/exec.js'
import { SocialGuard } from '../src/social/guard.js'
import { checkBody, FakeSessionManager, post, SECRET, sleep } from './helpers.js'

let app: FastifyInstance | undefined
beforeEach(() => { vi.stubEnv('BROWSER_RPC_SECRET', SECRET) })
afterEach(async () => { await app?.close(); app = undefined; vi.unstubAllEnvs() })

describe('signed browser execution diagnostics', () => {
  it('records the actual cooldown stop and never runs the executor a second time', async () => {
    const manager = new FakeSessionManager()
    const exec = vi.fn<typeof execCapability>().mockResolvedValue({ status: 'ok', data: { available: true } })
    ;({ app } = await buildBrowserServer({ sessionManager: manager, exec, socialGuard: new SocialGuard({ random: () => 0 }) }))
    const first = await post(app, '/v1/check', { ...checkBody('diagnostic-account'), diagnostics: true })
    expect(first.json().diagnostics.map((step: { id: string }) => step.id)).toEqual(['browser.session', 'browser.guard'])
    const stopped = (await post(app, '/v1/check', { ...checkBody('diagnostic-account'), diagnostics: true })).json()
    expect(stopped.error).toMatchObject({ code: 'RATE_LIMITED', retryable: false })
    expect(stopped.diagnostics).toEqual([
      expect.objectContaining({ id: 'browser.session', status: 'success' }),
      expect.objectContaining({ id: 'browser.guard', status: 'error', code: 'RATE_LIMITED' }),
    ])
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('reports a failed session acquisition without claiming a navigation happened', async () => {
    const manager = new FakeSessionManager()
    manager.world.failLaunch = true
    const exec = vi.fn<typeof execCapability>()
    ;({ app } = await buildBrowserServer({ sessionManager: manager, exec }))
    const result = (await post(app, '/v1/check', { ...checkBody('failed-session'), diagnostics: true })).json()
    expect(result.error.code).toBe('BROWSER_UNAVAILABLE')
    expect(result.diagnostics).toEqual([expect.objectContaining({ id: 'browser.session', status: 'error', code: 'BROWSER_UNAVAILABLE' })])
    expect(exec).not.toHaveBeenCalled()
  })

  it('returns diagnostics only when requested and binds replay to that request mode', async () => {
    const manager = new FakeSessionManager()
    const exec = vi.fn<typeof execCapability>().mockResolvedValue({ status: 'ok', data: {} })
    ;({ app } = await buildBrowserServer({ sessionManager: manager, exec }))
    const body = checkBody('private-request')
    expect((await post(app, '/v1/check', body)).json()).not.toHaveProperty('diagnostics')
    expect((await post(app, '/v1/check', { ...body, diagnostics: true })).statusCode).toBe(400)
    expect((await post(app, '/v1/check', { ...checkBody('private-request'), diagnostics: 'yes' })).statusCode).toBe(400)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('freezes timed-out stages before a late executor completion and excludes request values', async () => {
    const manager = new FakeSessionManager()
    manager.world.launchDelayMs = 0
    const exec = vi.fn<typeof execCapability>().mockImplementation(async (_context, _cap, _params, _deadline, _signal, _connector, diagnostics) => {
      const complete = diagnostics?.start('browser.navigate', '访问能力页面')
      await sleep(60)
      complete?.('success', '已访问站点页面')
      return { status: 'ok', data: {} }
    })
    ;({ app } = await buildBrowserServer({ sessionManager: manager, exec }))
    const result = (await post(app, '/v1/check', { ...checkBody('late-execution', 25), params: { private_value: 'never-include-request-values' }, diagnostics: true })).json()
    expect(result.error.code).toBe('UPSTREAM_TIMEOUT')
    expect(result.diagnostics.at(-1)).toMatchObject({ id: 'browser.navigate', status: 'error', code: 'UPSTREAM_TIMEOUT' })
    expect(JSON.stringify(result.diagnostics)).not.toContain('never-include-request-values')
    const snapshot = JSON.stringify(result.diagnostics)
    await sleep(80)
    expect(JSON.stringify(result.diagnostics)).toBe(snapshot)
  })
})
