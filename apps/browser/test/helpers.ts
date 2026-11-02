// Shared fakes: a real BrowserPool and SessionManager; only the Chromium
// launch and Xvfb are fake. Cookies live per profile directory, so a browser
// relaunched after idle reclaim sees the login state the old one left.

import { EventEmitter } from 'node:events'
import type { BrowserContext } from 'playwright'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { BrowserPool, XvfbManager, signRequest } from '@webridge/browser-runtime'
import type { BrowserPoolOptions } from '@webridge/browser-runtime'
import { SessionManager } from '../src/session.js'

export const SECRET = 'test-rpc-secret'

export class FakeXvfb extends XvfbManager {
  override async start() {
    return { display: ':99', pid: 0 }
  }
  override async stop() {}
}
// One instance: every XvfbManager adds a process 'exit' listener.
export const fakeXvfb = new FakeXvfb()

export interface FakeCookie {
  name: string
  value?: string
  domain: string
  path?: string
}

export class FakePage {
  gotoCalls: string[] = []
  current = 'about:blank'
  /** Visible text, for detectAuthFailure's risk-control check. */
  text = ''
  cdpCommands: string[] = []
  constructor(private readonly world: FakeWorld) {}
  /** Enough of the CDP surface for ScreencastSession. */
  context() {
    return {
      newCDPSession: async () => ({
        send: async (method: string) => {
          this.cdpCommands.push(method)
          return {}
        },
        on: () => undefined,
      }),
    }
  }
  async screenshot() {
    return Buffer.from('png')
  }

  url() {
    return this.current
  }
  async goto(next: string) {
    this.gotoCalls.push(next)
    if (this.world.gotoDelayMs) await sleep(this.world.gotoDelayMs)
    this.current = this.world.redirects[next] ?? next
    return null
  }
  async waitForLoadState() {}
  locator(selector: string) {
    return {
      first: () => ({ isVisible: async () => false }),
      innerText: async () => (selector === 'body' ? this.text : ''),
    }
  }
}

/** Mirrors Playwright: close() emits 'close' before it resolves. */
export class FakeContext extends EventEmitter {
  closed = false
  readonly page: FakePage
  constructor(
    private readonly jar: FakeCookie[],
    world: FakeWorld,
  ) {
    super()
    this.page = new FakePage(world)
  }
  pages() {
    return this.closed ? [] : [this.page]
  }
  async newPage() {
    return this.page
  }
  async cookies() {
    if (this.closed) throw new Error('Target page, context or browser has been closed')
    return this.jar
  }
  async addCookies(add: FakeCookie[]) {
    this.jar.push(...add)
  }
  async close() {
    if (this.closed) return
    this.closed = true
    this.emit('close', this)
  }
}

export class FakeWorld {
  launched: { dir: string; ctx: FakeContext }[] = []
  /** Cookie jar per profile directory. */
  profiles = new Map<string, FakeCookie[]>()
  /** goto(url) lands on redirects[url] when set (a logged-in site leaving its login page). */
  redirects: Record<string, string> = {}
  launchDelayMs = 10
  gotoDelayMs = 0
  failLaunch = false

  cookiesFor(dir: string): FakeCookie[] {
    let jar = this.profiles.get(dir)
    if (!jar) {
      jar = []
      this.profiles.set(dir, jar)
    }
    return jar
  }
}

export class FakePool extends BrowserPool {
  constructor(
    xvfb: XvfbManager,
    profilesDir: string,
    options: BrowserPoolOptions,
    private readonly world: FakeWorld,
  ) {
    super(xvfb, profilesDir, options)
  }
  protected override async launchContext(connectionId: string): Promise<BrowserContext> {
    const dir = this.profilePath(connectionId)
    await sleep(this.world.launchDelayMs)
    if (this.world.failLaunch) throw new Error('chromium failed to launch')
    const ctx = new FakeContext(this.world.cookiesFor(dir), this.world)
    this.world.launched.push({ dir, ctx })
    return ctx as unknown as BrowserContext
  }
}

export class FakeSessionManager extends SessionManager {
  readonly world = new FakeWorld()
  constructor(opts: { idleTimeoutMs?: number; profilesDir?: string } = {}) {
    super(
      opts.profilesDir ?? '/profiles-default',
      undefined,
      opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {},
    )
  }
  protected override createPool(
    _xvfb: XvfbManager,
    profilesDir: string,
    options: BrowserPoolOptions,
  ): BrowserPool {
    return new FakePool(fakeXvfb, profilesDir, options, this.world)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function until(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(5)
  }
}

export function post(app: FastifyInstance, url: string, body: unknown): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...signRequest(JSON.stringify(body), SECRET) },
    payload: JSON.stringify(body),
  })
}

export function signedGet(app: FastifyInstance, url: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, headers: signRequest(url, SECRET) })
}

let execSeq = 0
export function checkBody(connectionId: string, deadlineMs = 30_000) {
  return {
    connection_id: connectionId,
    exec_id: `exec-${++execSeq}`,
    capability: 'account.profile',
    params: { conn: connectionId },
    deadline_ms: deadlineMs,
  }
}
