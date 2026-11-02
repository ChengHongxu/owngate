import { EventEmitter } from 'node:events'
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { BrowserContext } from 'playwright'
import { BrowserPool, XvfbManager, signRequest } from '@webridge/browser-runtime'
import type { BrowserPoolOptions } from '@webridge/browser-runtime'
import { SessionManager } from '../src/session.js'
import { buildBrowserServer } from '../src/main.js'
import type { ExecResult } from '../src/exec.js'

const SECRET = 'test-rpc-secret'

// ── Fakes ─────────────────────────────────────────────────────────────────
// A real BrowserPool and SessionManager; only the browser launch and Xvfb are fake.

class FakeXvfb extends XvfbManager {
  override async start() {
    return { display: ':99', pid: 0 }
  }
  override async stop() {}
}
// One instance: every XvfbManager adds a process 'exit' listener.
const fakeXvfb = new FakeXvfb()

class FakePage {
  gotoCalls: string[] = []
  private current = 'about:blank'
  url() {
    return this.current
  }
  async goto(next: string) {
    this.gotoCalls.push(next)
    this.current = next
    return null
  }
}

/** Mirrors Playwright: close() emits 'close' before it resolves. */
class FakeContext extends EventEmitter {
  closed = false
  readonly page = new FakePage()
  pages() {
    return this.closed ? [] : [this.page]
  }
  async newPage() {
    return this.page
  }
  async cookies() {
    return []
  }
  async close() {
    if (this.closed) return
    this.closed = true
    this.emit('close', this)
  }
}

class FakePool extends BrowserPool {
  constructor(
    xvfb: XvfbManager,
    readonly profilesDirUsed: string,
    options: BrowserPoolOptions,
    private readonly launched: { dir: string; ctx: FakeContext }[],
  ) {
    super(xvfb, profilesDirUsed, options)
  }
  protected override async launchContext(): Promise<BrowserContext> {
    await sleep(10)
    const ctx = new FakeContext()
    this.launched.push({ dir: this.profilesDirUsed, ctx })
    return ctx as unknown as BrowserContext
  }
}

class FakeBrowserSessionManager extends SessionManager {
  readonly launched: { dir: string; ctx: FakeContext }[] = []
  constructor(private readonly idleTimeoutMs?: number) {
    super('/profiles-default')
  }
  protected override createPool(
    _xvfb: XvfbManager,
    profilesDir: string,
    options: BrowserPoolOptions,
  ): BrowserPool {
    const opts =
      this.idleTimeoutMs !== undefined ? { ...options, idleTimeoutMs: this.idleTimeoutMs } : options
    return new FakePool(fakeXvfb, profilesDir, opts, this.launched)
  }
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

let execSeq = 0
function checkBody(connectionId: string) {
  return {
    connection_id: connectionId,
    exec_id: `exec-${++execSeq}`,
    capability: 'account.profile',
    params: { conn: connectionId },
    deadline_ms: 30_000,
  }
}

function post(app: FastifyInstance, url: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...signRequest(JSON.stringify(body), SECRET) },
    payload: body,
  })
}

beforeAll(() => {
  process.env['BROWSER_RPC_SECRET'] = SECRET
})

// ── /v1/check serialization ───────────────────────────────────────────────

describe('/v1/check concurrency', () => {
  let app: FastifyInstance
  let sm: FakeBrowserSessionManager
  const spans: Span[] = []

  beforeAll(async () => {
    sm = new FakeBrowserSessionManager()
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
    expect(sm.launched).toHaveLength(1)
  })

  it('runs checks on different connections in parallel (the test can see overlap)', async () => {
    await Promise.all([
      post(app, '/v1/check', checkBody('a')),
      post(app, '/v1/check', checkBody('b')),
    ])
    expect(spans).toHaveLength(2)
    expect(overlaps(spans[0]!, spans[1]!)).toBe(true)
  })
})

// ── Stale entries after idle reclaim ──────────────────────────────────────

describe('SessionManager after the pool closes a browser', () => {
  it('drops the entry on the context close event and relaunches on the next use', async () => {
    const sm = new FakeBrowserSessionManager(20)
    const first = await sm.entry('c1')
    expect(sm.getEntry('c1')).toBe(first)

    await sleep(60) // idle reclaim
    expect(sm.launched[0]?.ctx.closed).toBe(true)
    expect(sm.getEntry('c1')).toBeUndefined()

    const second = await sm.entry('c1')
    expect(second).not.toBe(first)
    expect(second.context.pages()).toHaveLength(1)
    expect(sm.launched).toHaveLength(2)
    await sm.closeAll()
  })

  it('/v1/check after idle reclaim runs on a live browser, /v1/probe reports needs_auth until then', async () => {
    const sm = new FakeBrowserSessionManager(20)
    let seenPages = -1
    const exec = async (ctx: BrowserContext): Promise<ExecResult> => {
      seenPages = ctx.pages().length
      return { status: 'ok' }
    }
    const { app } = await buildBrowserServer({ exec, sessionManager: sm })
    try {
      await post(app, '/v1/check', checkBody('c1'))
      await sleep(60)
      const probe = await post(app, '/v1/probe', { connection_id: 'c1', capability: 'x' })
      expect(JSON.parse(probe.body)).toEqual({ support: 'needs_auth' })

      const resp = await post(app, '/v1/check', checkBody('c1'))
      expect(resp.statusCode).toBe(200)
      expect(seenPages).toBe(1)
      expect(sm.launched).toHaveLength(2)
    } finally {
      await sm.closeAll()
      await app.close()
    }
  })

  it('relaunches with the profile dir given to openSession', async () => {
    const sm = new FakeBrowserSessionManager(20)
    await sm.openSession('c1', '/profiles-custom')
    await sleep(60)
    await sm.entry('c1')
    expect(sm.launched.map((l) => l.dir)).toEqual(['/profiles-custom', '/profiles-custom'])
    await sm.closeAll()
  })

  it('closeSession drops the entry', async () => {
    const sm = new FakeBrowserSessionManager()
    await sm.entry('c1')
    await sm.closeSession('c1')
    expect(sm.getEntry('c1')).toBeUndefined()
    expect(sm.launched[0]?.ctx.closed).toBe(true)
  })
})

// ── startLogin and the connection lock ────────────────────────────────────

describe('SessionManager.startLogin locking', () => {
  it('waits for the connection lock before navigating and releases it after', async () => {
    const sm = new FakeBrowserSessionManager()
    const entry = await sm.entry('c1')
    const page = sm.launched[0]!.ctx.page

    const release = await entry.lock.acquire()
    const starting = sm.startLogin('c1', 'https://passport.bilibili.com/login', {
      successWhen: { type: 'cookie', name: 'SESSDATA', domain: '.bilibili.com' },
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
