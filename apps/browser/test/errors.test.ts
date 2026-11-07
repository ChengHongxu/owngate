// Worker error bodies use shared error codes only, deadline_ms is
// enforced, and connection_id is checked before it reaches a path.

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { BrowserContext } from 'playwright'
import { buildBrowserServer } from '../src/main.js'
import { workerError } from '../src/errors.js'
import { CODE_CLASSIFICATION, type ErrorCode } from '@owngate/core'
import type { ExecResult } from '../src/exec.js'
import { FakeSessionManager, SECRET, checkBody, post, signedGet, sleep, until } from './helpers.js'

const EXPECTED = new Map(Object.entries(CODE_CLASSIFICATION).map(([code, value]) => [code, value.retryable]))

describe('error code contract', () => {
  it('uses the shared retry policy for every worker error', () => {
    for (const code of Object.keys(CODE_CLASSIFICATION) as ErrorCode[]) {
      expect(workerError(code, 'what happened', 'next step')).toEqual({
        code, what_happened: 'what happened', next_step: 'next step',
        retryable: CODE_CLASSIFICATION[code].retryable,
      })
    }
  })
})

// ── Every error body the worker sends ─────────────────────────────────────

let built: { app: FastifyInstance; sm: FakeSessionManager }[] = []

type Exec = (
  ctx: BrowserContext,
  capability: string,
  params: Record<string, unknown>,
  deadlineMs: number,
  signal?: AbortSignal,
) => Promise<ExecResult>

async function server(exec?: Exec) {
  const sm = new FakeSessionManager()
  const { app } = await buildBrowserServer({ sessionManager: sm, ...(exec ? { exec } : {}) })
  built.push({ app, sm })
  return { app, sm }
}

beforeAll(() => {
  process.env['BROWSER_RPC_SECRET'] = SECRET
})

afterEach(async () => {
  for (const { app, sm } of built) {
    await sm.closeAll()
    await app.close()
  }
  built = []
})

/** Extract the error body: flat for HTTP errors, nested for /v1/check outcomes. */
function errorOf(resp: LightMyRequestResponse): Record<string, unknown> | undefined {
  const body = JSON.parse(resp.body) as Record<string, unknown>
  if (resp.statusCode >= 400) return body
  return body['error'] as Record<string, unknown> | undefined
}

function expectSpecError(resp: LightMyRequestResponse, code: string, status?: number) {
  if (status !== undefined) expect(resp.statusCode).toBe(status)
  const error = errorOf(resp)
  expect(error).toBeDefined()
  expect(Object.keys(error!).sort()).toEqual(['code', 'next_step', 'retryable', 'what_happened'])
  expect(EXPECTED.has(String(error!['code']))).toBe(true)
  expect(error!['code']).toBe(code)
  expect(error!['retryable']).toBe(EXPECTED.get(code))
}

describe('worker error bodies', () => {
  it('signature failure → 401 UNAUTHENTICATED', async () => {
    const { app } = await server()
    const resp = await app.inject({
      method: 'POST',
      url: '/v1/check',
      headers: { 'content-type': 'application/json' },
      payload: checkBody('c1'),
    })
    expectSpecError(resp, 'UNAUTHENTICATED', 401)
  })

  it.each([
    ['/v1/session/open', { connection_id: 'c1', profile_path: '/etc' }],
    ['/v1/session/open', {}],
    ['/v1/check', { ...checkBody('c1'), deadline_ms: undefined }],
    ['/v1/check', { ...checkBody('c1'), deadline_ms: -1 }],
    ['/v1/check', { ...checkBody('c1'), params: [1] }],
    ['/v1/cancel', {}],
    ['/v1/cookies/import', { connection_id: 'c1', cookies: [] }],
    ['/v1/login/start', { connection_id: 'c1', url: 'https://x.com/' }],
  ])('bad params on %s → 400 INVALID_PARAMS', async (url, body) => {
    const { app } = await server()
    expectSpecError(await post(app, url, body), 'INVALID_PARAMS', 400)
  })

  it('malformed JSON → 400 INVALID_PARAMS', async () => {
    const { app } = await server()
    const resp = await app.inject({
      method: 'POST',
      url: '/v1/check',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    })
    expectSpecError(resp, 'INVALID_PARAMS', 400)
  })

  it('unknown route → INVALID_PARAMS body, not the Fastify default', async () => {
    const { app } = await server()
    const resp = await signedGet(app, '/v1/nope')
    expect(resp.statusCode).toBe(404)
    expectSpecError(resp, 'INVALID_PARAMS')
  })

  it('cookie refused by the browser → 400 INVALID_PARAMS without the cookie text', async () => {
    const { app, sm } = await server()
    const entry = await sm.entry('c1')
    ;(entry.context as unknown as { addCookies: () => Promise<never> }).addCookies = async () => {
      throw new Error('Invalid cookie value s3cr3t')
    }
    const resp = await post(app, '/v1/cookies/import', {
      connection_id: 'c1',
      cookies: [{ name: 'SESSDATA', value: 's3cr3t', domain: '.bilibili.com' }],
    })
    expectSpecError(resp, 'INVALID_PARAMS', 400)
    expect(resp.body).not.toContain('s3cr3t')
  })

  it('cookie import with a browser that cannot start → 503 BROWSER_UNAVAILABLE', async () => {
    const { app, sm } = await server()
    sm.world.failLaunch = true
    const resp = await post(app, '/v1/cookies/import', {
      connection_id: 'c1',
      cookies: [{ name: 'SESSDATA', value: 'v', domain: '.bilibili.com' }],
    })
    expectSpecError(resp, 'BROWSER_UNAVAILABLE', 503)
  })

  it('session/open with a browser that cannot start → 503 BROWSER_UNAVAILABLE', async () => {
    const { app, sm } = await server()
    sm.world.failLaunch = true
    expectSpecError(await post(app, '/v1/session/open', { connection_id: 'c1' }), 'BROWSER_UNAVAILABLE', 503)
  })

  it('/v1/check whose executor throws → BROWSER_UNAVAILABLE, not cached', async () => {
    let calls = 0
    const { app } = await server(async () => {
      calls++
      throw new Error('page crashed')
    })
    const body = checkBody('c1')
    expectSpecError(await post(app, '/v1/check', body), 'BROWSER_UNAVAILABLE', 200)
    await post(app, '/v1/check', body)
    expect(calls).toBe(2)
  })

  it('/v1/check with a browser that cannot start → BROWSER_UNAVAILABLE', async () => {
    const { app, sm } = await server()
    sm.world.failLaunch = true
    expectSpecError(await post(app, '/v1/check', checkBody('c1')), 'BROWSER_UNAVAILABLE', 200)
  })

  it('/v1/check on a login page → LOGIN_REQUIRED from the real executor', async () => {
    const { app, sm } = await server()
    const entry = await sm.entry('c1')
    await entry.context.pages()[0]!.goto('https://passport.bilibili.com/login')
    expectSpecError(await post(app, '/v1/check', { ...checkBody('c1'), params: {} }), 'LOGIN_REQUIRED', 200)
  })
})

// ── deadline_ms on /v1/check ──────────────────────────────────────────────

describe('/v1/check deadline_ms', () => {
  it('answers UPSTREAM_TIMEOUT at the deadline instead of hanging, and signals the executor', async () => {
    let aborted = false
    let finished = false
    const { app } = await server(async (_ctx, _cap, _params, _deadline, signal) => {
      signal?.addEventListener('abort', () => {
        aborted = true
      })
      await sleep(300)
      finished = true
      return { status: 'ok' }
    })
    const t0 = performance.now()
    const resp = await post(app, '/v1/check', checkBody('c1', 50))
    expect(performance.now() - t0).toBeLessThan(250)
    expectSpecError(resp, 'UPSTREAM_TIMEOUT', 200)
    expect(aborted).toBe(true)
    expect(finished).toBe(false)
  })

  it('keeps the lock until the timed-out executor settles, and does not cache the timeout', async () => {
    const spans: [number, number][] = []
    const { app } = await server(async () => {
      const enter = performance.now()
      await sleep(100)
      spans.push([enter, performance.now()])
      return { status: 'ok', data: 'done' }
    })
    const body = checkBody('c1', 30)
    const first = await post(app, '/v1/check', body)
    expectSpecError(first, 'UPSTREAM_TIMEOUT')
    // Same exec_id again, with time to finish: runs anew after the first exec lets go.
    const second = await post(app, '/v1/check', { ...body, deadline_ms: 5_000 })
    expect(JSON.parse(second.body)).toEqual({ status: 'ok', data: 'done' })
    await until(() => spans.length === 2)
    expect(spans[1]![0]).toBeGreaterThanOrEqual(spans[0]![1])
  })

  it('a deadline that passes while waiting for the lock never runs the executor', async () => {
    let calls = 0
    const { app, sm } = await server(async () => {
      calls++
      return { status: 'ok' }
    })
    const entry = await sm.entry('c1')
    const unlock = await entry.lock.acquire()
    expectSpecError(await post(app, '/v1/check', checkBody('c1', 30)), 'UPSTREAM_TIMEOUT')
    unlock()
    await sleep(10)
    expect(calls).toBe(0)
    expect(sm.leaseCount('c1')).toBe(0)
  })
})

// ── connection_id validation ──────────────────────────────────────────────

describe('connection_id validation', () => {
  const bad = ['../../etc', 'a/b', '..', '', 'x'.repeat(65), 'c1\n', 7]
  const routes: [string, (id: unknown) => Record<string, unknown>][] = [
    ['/v1/session/open', (id) => ({ connection_id: id })],
    ['/v1/session/close', (id) => ({ connection_id: id })],
    ['/v1/login/start', (id) => ({
      connection_id: id,
      url: 'https://passport.bilibili.com/login',
      success_when: [{ type: 'url_not_contains', pattern: 'login' }],
    })],
    ['/v1/login/stop', (id) => ({ connection_id: id })],
    ['/v1/cookies/import', (id) => ({
      connection_id: id,
      cookies: [{ name: 'a', value: 'b', domain: '.x.com' }],
    })],
    ['/v1/check', (id) => ({ ...checkBody('x'), connection_id: id })],
    ['/v1/probe', (id) => ({
      connection_id: id,
      login_url: 'https://x.com/login',
      success_when: [{ type: 'cookie', name: 'a', domain: '.x.com' }],
      deadline_ms: 1_000,
    })],
  ]

  it.each(routes)('%s rejects every bad id with 400 and launches nothing', async (url, make) => {
    const { app, sm } = await server()
    for (const id of bad) {
      expectSpecError(await post(app, url, make(id)), 'INVALID_PARAMS', 400)
    }
    expect(sm.world.launched).toHaveLength(0)
  })

  it('GET /v1/login/status rejects a bad id', async () => {
    const { app } = await server()
    expectSpecError(await signedGet(app, '/v1/login/status?connection_id=..%2F..%2Fetc'), 'INVALID_PARAMS', 400)
  })

  it('SessionManager itself refuses a bad id (defence behind the routes)', async () => {
    const sm = new FakeSessionManager()
    await expect(sm.openSession('../escape')).rejects.toThrow(/connection_id/)
    await expect(
      sm.startLogin('a/b', 'https://x.com/', { successWhen: [{ type: 'url_not_contains', pattern: 'x' }] }),
    ).rejects.toThrow(/connection_id/)
    expect(sm.world.launched).toHaveLength(0)
  })
})
