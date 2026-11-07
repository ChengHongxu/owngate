import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { BrowserContext } from 'playwright'
import { buildBrowserServer } from '../src/main.js'
import type { ExecResult } from '../src/exec.js'
import { FakeSessionManager, SECRET, checkBody, post, sleep, until } from './helpers.js'

interface Span {
  connectionId: string
  enter: number
  exit: number
}

/** Exec that sleeps and records when it ran. */
function recordingExec(spans: Span[], ms: number) {
  return async (
    context: BrowserContext,
    capability: string,
    params: Record<string, unknown>,
  ): Promise<ExecResult> => {
    const enter = performance.now()
    await sleep(ms)
    spans.push({ connectionId: String(params['conn']), enter, exit: performance.now() })
    return { status: 'ok', data: { capability, pages: context.pages().length } }
  }
}

function overlaps(a: Span, b: Span): boolean {
  return a.enter < b.exit && b.enter < a.exit
}

beforeAll(() => {
  process.env['BROWSER_RPC_SECRET'] = SECRET
})

// ── /v1/check serialization ───────────────────────────────────────────────

describe('/v1/check concurrency', () => {
  let app: FastifyInstance
  let sm: FakeSessionManager
  const spans: Span[] = []

  beforeAll(async () => {
    sm = new FakeSessionManager()
    app = (await buildBrowserServer({ exec: recordingExec(spans, 40), sessionManager: sm })).app
  })

  afterAll(async () => {
    await sm.closeAll()
    await app.close()
  })

  afterEach(() => {
    spans.length = 0
  })

  it('runs two cold-start checks on one connection one after the other, on one browser', async () => {
    const [r1, r2] = await Promise.all([
      post(app, '/v1/check', checkBody('same')),
      post(app, '/v1/check', checkBody('same')),
    ])
    expect(r1.statusCode).toBe(200)
    expect(r2.statusCode).toBe(200)
    expect(spans).toHaveLength(2)
    expect(overlaps(spans[0]!, spans[1]!)).toBe(false)
    expect(sm.world.launched).toHaveLength(1)
  })

  it('runs checks on different connections in parallel (the test can see overlap)', async () => {
    await Promise.all([
      post(app, '/v1/check', checkBody('a')),
      post(app, '/v1/check', checkBody('b')),
    ])
    expect(spans).toHaveLength(2)
    expect(overlaps(spans[0]!, spans[1]!)).toBe(true)
  })

  it('shares one execution for simultaneous retries with the same exec_id', async () => {
    const body = checkBody('same-retry')
    const [first, second] = await Promise.all([post(app, '/v1/check', body), post(app, '/v1/check', body)])
    expect(first.json()).toEqual(second.json())
    expect(spans).toHaveLength(1)
    const replay = await post(app, '/v1/check', body)
    expect(replay.json()).toEqual(first.json())
    expect(spans).toHaveLength(1)
  })

  it('rejects exec_id reuse for a different account or parameters', async () => {
    const body = checkBody('identity-a')
    const first = post(app, '/v1/check', body).then((response) => response)
    await until(() => sm.getEntry('identity-a') !== undefined)
    const conflict = await post(app, '/v1/check', { ...body, connection_id: 'identity-b' })
    expect(conflict.statusCode).toBe(400)
    expect(conflict.json().code).toBe('INVALID_PARAMS')
    await first
    const changed = await post(app, '/v1/check', { ...body, params: { conn: 'changed' } })
    expect(changed.statusCode).toBe(400)
    expect(spans).toHaveLength(1)
  })
})

// ── Stale entries after idle reclaim ──────────────────────────────────────

describe('SessionManager after the pool closes a browser', () => {
  it('drops the entry on the context close event and relaunches on the next use', async () => {
    const sm = new FakeSessionManager({ idleTimeoutMs: 20 })
    const first = await sm.entry('c1')
    expect(sm.getEntry('c1')).toBe(first)

    await sleep(60) // idle reclaim
    expect(sm.world.launched[0]?.ctx.closed).toBe(true)
    expect(sm.getEntry('c1')).toBeUndefined()

    const second = await sm.entry('c1')
    expect(second).not.toBe(first)
    expect(second.context.pages()).toHaveLength(1)
    expect(sm.world.launched).toHaveLength(2)
    await sm.closeAll()
  })

  it('/v1/check after idle reclaim runs on a live browser', async () => {
    const sm = new FakeSessionManager({ idleTimeoutMs: 20 })
    let seenPages = -1
    const exec = async (ctx: BrowserContext): Promise<ExecResult> => {
      seenPages = ctx.pages().length
      return { status: 'ok' }
    }
    const { app } = await buildBrowserServer({ exec, sessionManager: sm })
    try {
      await post(app, '/v1/check', checkBody('c1'))
      await sleep(60)
      expect(sm.getEntry('c1')).toBeUndefined()
      const resp = await post(app, '/v1/check', checkBody('c1'))
      expect(resp.statusCode).toBe(200)
      expect(seenPages).toBe(1)
      expect(sm.world.launched).toHaveLength(2)
    } finally {
      await sm.closeAll()
      await app.close()
    }
  })

  it('profiles live at <worker profiles root>/<connection_id>, also after a relaunch', async () => {
    const sm = new FakeSessionManager({ idleTimeoutMs: 20, profilesDir: '/profiles-root' })
    await sm.openSession('c1')
    await sleep(60)
    await sm.entry('c1')
    expect(sm.world.launched.map((l) => l.dir)).toEqual(['/profiles-root/c1', '/profiles-root/c1'])
    await sm.closeAll()
  })

  it('closeSession drops the entry', async () => {
    const sm = new FakeSessionManager()
    await sm.entry('c1')
    await sm.closeSession('c1')
    expect(sm.getEntry('c1')).toBeUndefined()
    expect(sm.world.launched[0]?.ctx.closed).toBe(true)
  })
})

// ── startLogin and the connection lock ────────────────────────────────────

describe('SessionManager.startLogin locking', () => {
  it('waits for the connection lock before navigating and releases it after', async () => {
    const sm = new FakeSessionManager()
    const entry = await sm.entry('c1')
    const page = sm.world.launched[0]!.ctx.page

    const release = await entry.lock.acquire()
    const starting = sm.startLogin('c1', 'https://passport.bilibili.com/login', {
      successWhen: [{ type: 'cookie', name: 'SESSDATA', domain: '.bilibili.com' }],
      deadlineMs: 60_000,
    })
    await sleep(20)
    expect(page.gotoCalls).toEqual([])
    release()
    await starting
    expect(page.gotoCalls).toEqual(['https://passport.bilibili.com/login'])

    // The login wait (60s here) runs in the background without the lock.
    expect(sm.getLoginState('c1').status).toBe('pending')
    const again = await Promise.race([
      entry.lock.acquire(),
      sleep(200).then(() => undefined),
    ])
    expect(again).toBeTypeOf('function')
    again?.()

    await sm.stopLogin('c1')
    await sm.closeAll()
  })
})
