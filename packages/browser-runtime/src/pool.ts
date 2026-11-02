// One BrowserContext per connection, launched in headed mode on its Xvfb display.
// Idle timeout: 10 minutes (configurable). Connection-level serialization via async mutex.

import { chromium, type BrowserContext } from 'playwright'
import { AsyncMutex } from './mutex.js'
import { XvfbManager } from './xvfb.js'
import { type ProxyCredentialStore, proxyServerFlag } from './proxy.js'

export interface BrowserEntry {
  context: BrowserContext
  display: string
  connectionId: string
  lock: AsyncMutex
  /**
   * Proxy username used by this browser (the connection id). Present only when
   * the pool was built with a proxy. Safe to log — the password never is.
   */
  proxyUsername?: string
}

export interface BrowserPoolOptions {
  idleTimeoutMs?: number
  /**
   * Egress proxy (design §4.4.1/§4.4.6). When absent the browser talks to the
   * network directly, which the design does not permit in production — wire this
   * up wherever the pool is constructed.
   */
  proxy?: {
    /** e.g. 'http://egress:3128' */
    proxyServer: string
    credentials: ProxyCredentialStore
  }
}

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000

type PoolEntry = BrowserEntry & { idleTimer: NodeJS.Timeout }

export class BrowserPool {
  private entries = new Map<string, PoolEntry>()
  /**
   * In-flight launches. Concurrent acquire() calls for one connection share the
   * same promise, so a profile is never launched twice (two launches would hold
   * two different locks and fight over Chromium's profile SingletonLock).
   */
  private pending = new Map<string, Promise<BrowserEntry>>()
  /** In-flight closes. A relaunch waits for these so the old browser has let go of the profile. */
  private closing = new Map<string, Promise<void>>()
  private idleTimeoutMs: number
  private proxy: BrowserPoolOptions['proxy']

  constructor(
    private readonly xvfb: XvfbManager,
    private readonly profilesDir: string,
    options?: BrowserPoolOptions,
  ) {
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.proxy = options?.proxy
  }

  async acquire(connectionId: string): Promise<BrowserEntry> {
    const existing = this.entries.get(connectionId)
    if (existing) {
      this.resetIdleTimer(connectionId)
      return existing
    }
    const inflight = this.pending.get(connectionId)
    if (inflight) return inflight
    // create() stores the entry before it resolves, so once this promise
    // settles a later acquire() finds it in `entries`. On failure nothing is
    // stored and the next acquire() retries.
    const created = this.create(connectionId).finally(() => {
      this.pending.delete(connectionId)
    })
    this.pending.set(connectionId, created)
    return created
  }

  release(connectionId: string): void {
    // Marks as idle by (re)starting the idle timer; does NOT close the context.
    this.resetIdleTimer(connectionId)
  }

  async close(connectionId: string): Promise<void> {
    // A launch in progress would otherwise land after this close and survive it.
    const inflight = this.pending.get(connectionId)
    if (inflight) await inflight.catch(() => undefined)

    const entry = this.entries.get(connectionId)
    if (!entry) {
      await this.closing.get(connectionId)
      return
    }
    // Remove first: the context's 'close' event then finds nothing to evict.
    clearTimeout(entry.idleTimer)
    this.entries.delete(connectionId)
    const done = (async () => {
      try {
        await entry.context.close()
      } catch {
        // ignore — context may already be closed
      }
      await this.xvfb.stop(connectionId)
    })()
    this.closing.set(connectionId, done)
    try {
      await done
    } finally {
      if (this.closing.get(connectionId) === done) this.closing.delete(connectionId)
    }
  }

  async closeAll(): Promise<void> {
    // Include launches still in flight; close() waits for them.
    const ids = new Set([...this.entries.keys(), ...this.pending.keys()])
    await Promise.all(Array.from(ids, (id) => this.close(id)))
  }

  private async create(connectionId: string): Promise<BrowserEntry> {
    const closing = this.closing.get(connectionId)
    if (closing) await closing

    const { display } = await this.xvfb.start(connectionId)
    let context: BrowserContext
    try {
      context = await this.launchContext(connectionId, display)
    } catch (e) {
      await this.xvfb.stop(connectionId)
      throw e
    }

    const proxyUsername = this.proxy?.credentials.get(connectionId)?.username
    const entry: PoolEntry = {
      context,
      display,
      connectionId,
      lock: new AsyncMutex(),
      idleTimer: this.startIdleTimer(connectionId),
      // Spread rather than `proxyUsername: proxyUsername`: under
      // exactOptionalPropertyTypes an explicit undefined is not assignable to an
      // optional `string` property. Username only — never log the password.
      ...(proxyUsername !== undefined ? { proxyUsername } : {}),
    }
    // The browser can go away without close(): a crash, or the window closed on
    // the remote screen. Drop the entry so the next acquire() relaunches instead
    // of handing out a dead context.
    context.on('close', () => this.evict(connectionId, entry))
    this.entries.set(connectionId, entry)
    return entry
  }

  /**
   * Launch a ready-to-use persistent context for one connection on `display`.
   * Protected so tests can substitute a fake browser.
   */
  protected async launchContext(connectionId: string, display: string): Promise<BrowserContext> {
    const profilePath = `${this.profilesDir}/${connectionId}`

    // Proxy wiring (design §4.4.1: 出网必经 egress-proxy).
    //
    // Credentials go in Playwright's `proxy` option, never in --proxy-server:
    // Chromium parses `--proxy-server=http://user:pass@host:port` as a malformed
    // proxy and drops it, failing every request with ERR_NO_SUPPORTED_PROXIES
    // (verified against the bundled Chromium 1248). Playwright instead passes the
    // bare server to --proxy-server and answers the proxy's 407 challenge over
    // CDP, which the egress-proxy accepts (Proxy-Authorization: Basic ...).
    //
    // bypass: '<-loopback>' is what forces loopback through the proxy. Chromium
    // has *implicit* loopback bypass rules; an empty bypass list does not clear
    // them (measured: `--proxy-bypass-list=` still sent 127.0.0.1 direct), only
    // the '<-loopback>' token subtracts them. Without it, a page could reach
    // host services (db, redis, the API) without ever touching the proxy.
    const proxyCreds = this.proxy?.credentials.get(connectionId)
    const proxyOption =
      this.proxy && proxyCreds
        ? {
            server: proxyServerFlag(this.proxy.proxyServer),
            username: proxyCreds.username,
            password: proxyCreds.password,
            bypass: '<-loopback>',
          }
        : undefined

    const context = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      // Playwright defaults this to false, which injects --no-sandbox.
      // Design doc §4.4.1/§12.2 forbids running without the Chromium sandbox.
      chromiumSandbox: true,
      ...(proxyOption ? { proxy: proxyOption } : {}),
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        `--display=${display}`,
        // Use the user-namespace sandbox, not the setuid helper: the bundled
        // chrome_sandbox binary expects API version 0 while Playwright's
        // Chromium ships version 1 ("you need 0"), so the setuid path aborts.
        // SYS_ADMIN (compose) makes unshare -U available; --no-sandbox stays out.
        '--disable-setuid-sandbox',
        '--namespace-sandbox',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1280, height: 800 },
    })

    // Remove navigator.webdriver after context creation
    try {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      })
    } catch (e) {
      await context.close().catch(() => undefined)
      throw e
    }
    return context
  }

  /** Context closed on its own. Ignored when close() already removed this entry. */
  private evict(connectionId: string, entry: PoolEntry): void {
    if (this.entries.get(connectionId) !== entry) return
    clearTimeout(entry.idleTimer)
    this.entries.delete(connectionId)
    void this.xvfb.stop(connectionId)
  }

  private startIdleTimer(connectionId: string): NodeJS.Timeout {
    return setTimeout(() => {
      void this.close(connectionId)
    }, this.idleTimeoutMs)
  }

  private resetIdleTimer(connectionId: string): void {
    const entry = this.entries.get(connectionId)
    if (!entry) return
    clearTimeout(entry.idleTimer)
    entry.idleTimer = this.startIdleTimer(connectionId)
  }
}
