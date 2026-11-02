// One BrowserContext per connection, launched in headed mode on its Xvfb display.
//
// Idle reclaim (design §4.4.1, §13.1): a browser nobody uses for 10 minutes
// (configurable) is closed and relaunched on the next acquire(). Work that
// must not be cut short — a login wait, a screencast socket, /v1/check,
// /v1/probe — takes a lease with hold(); while any lease is out the browser
// is never idle. The last release restarts the idle timer.
//
// Closing (idle reclaim, close(), closeAll()) takes the entry's lock first, so
// it waits for the request currently holding it instead of closing the
// context underneath it. Callers must therefore never call close() while they
// hold that entry's lock; nothing in this package does.

import { resolve, sep } from 'node:path'
import { chromium, type BrowserContext } from 'playwright'
import { AsyncMutex } from './mutex.js'
import { XvfbManager } from './xvfb.js'
import { type ProxyCredentialStore, proxyServerFlag } from './proxy.js'
import { assertConnectionId, isValidConnectionId } from './connection-id.js'

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

type PoolEntry = BrowserEntry & {
  /** Absent while a lease is out. */
  idleTimer?: NodeJS.Timeout
  /** Bumped on every use; an idle reclaim that sees it change backs off. */
  idleGen: number
}

export class BrowserPool {
  private entries = new Map<string, PoolEntry>()
  /**
   * In-flight launches. Concurrent acquire() calls for one connection share the
   * same promise, so a profile is never launched twice (two launches would hold
   * two different locks and fight over Chromium's profile SingletonLock).
   */
  private pending = new Map<string, Promise<BrowserEntry>>()
  /**
   * In-flight closes, including the Xvfb stop after a crash. A relaunch waits
   * for these so the old browser has let go of the profile and the display.
   */
  private closing = new Map<string, Promise<void>>()
  /**
   * Lease counts per connection. Keyed by connection, not entry: a lease taken
   * before the browser launches (or across a crash and relaunch) still counts.
   */
  private leases = new Map<string, number>()
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

  /** Throws InvalidConnectionIdError for an id outside CONNECTION_ID_RE. */
  async acquire(connectionId: string): Promise<BrowserEntry> {
    assertConnectionId(connectionId)
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

  /**
   * Take a lease: the connection's browser is not idle-reclaimed until every
   * lease is released. Returns the release function; calling it twice is a
   * no-op. Does not launch a browser (pair it with acquire(), or use lease()).
   * close() still closes a leased browser — leases only stop idle reclaim.
   */
  hold(connectionId: string): () => void {
    assertConnectionId(connectionId)
    this.leases.set(connectionId, (this.leases.get(connectionId) ?? 0) + 1)
    const entry = this.entries.get(connectionId)
    if (entry) {
      clearTimeout(entry.idleTimer)
      delete entry.idleTimer
      entry.idleGen++
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (this.leases.get(connectionId) ?? 1) - 1
      if (left > 0) {
        this.leases.set(connectionId, left)
        return
      }
      this.leases.delete(connectionId)
      this.resetIdleTimer(connectionId)
    }
  }

  /** hold() + acquire(). The lease is released again when the launch fails. */
  async lease(connectionId: string): Promise<{ entry: BrowserEntry; release: () => void }> {
    const release = this.hold(connectionId)
    try {
      return { entry: await this.acquire(connectionId), release }
    } catch (e) {
      release()
      throw e
    }
  }

  leaseCount(connectionId: string): number {
    return this.leases.get(connectionId) ?? 0
  }

  /** The live entry, or undefined. Never launches. */
  get(connectionId: string): BrowserEntry | undefined {
    return this.entries.get(connectionId)
  }

  release(connectionId: string): void {
    // Marks as idle by (re)starting the idle timer; does NOT close the context.
    this.resetIdleTimer(connectionId)
  }

  /**
   * Close the connection's browser. Waits for a launch in flight and for the
   * holder of the entry's lock, so a running request finishes first. Must not
   * be called while holding that lock.
   */
  async close(connectionId: string): Promise<void> {
    if (!isValidConnectionId(connectionId)) return
    // A launch in progress would otherwise land after this close and survive it.
    const inflight = this.pending.get(connectionId)
    if (inflight) await inflight.catch(() => undefined)

    const entry = this.entries.get(connectionId)
    if (!entry) {
      await this.closing.get(connectionId)
      return
    }
    await this.closeEntry(entry)
  }

  async closeAll(): Promise<void> {
    // Include launches still in flight; close() waits for them.
    const ids = new Set([...this.entries.keys(), ...this.pending.keys()])
    await Promise.all(Array.from(ids, (id) => this.close(id)))
  }

  /**
   * Remove `entry` from the map at once (new acquires then wait in create()
   * for this close), then close it under its lock. Lock waiters that got the
   * entry earlier run before the close and must re-check that the entry is
   * still current (see SessionManager.withLockedEntry).
   */
  private async closeEntry(entry: PoolEntry, heldUnlock?: () => void): Promise<void> {
    const { connectionId } = entry
    clearTimeout(entry.idleTimer)
    delete entry.idleTimer
    // Remove first: the context's 'close' event then finds nothing to evict.
    this.entries.delete(connectionId)
    const done = (async () => {
      const unlock = heldUnlock ?? (await entry.lock.acquire())
      try {
        await entry.context.close()
      } catch {
        // ignore — context may already be closed
      } finally {
        unlock()
      }
      await this.xvfb.stop(connectionId)
    })()
    this.trackClosing(connectionId, done)
    await done
  }

  private trackClosing(connectionId: string, done: Promise<void>): void {
    const prev = this.closing.get(connectionId)
    const all = prev ? Promise.all([prev, done]).then(() => undefined) : done
    const settled = all.catch(() => undefined)
    this.closing.set(connectionId, settled)
    void settled.finally(() => {
      if (this.closing.get(connectionId) === settled) this.closing.delete(connectionId)
    })
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
      idleGen: 0,
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
    this.resetIdleTimer(connectionId)
    return entry
  }

  /** Profile directory for a connection: always a direct child of profilesDir. */
  protected profilePath(connectionId: string): string {
    assertConnectionId(connectionId)
    const root = resolve(this.profilesDir)
    const path = resolve(root, connectionId)
    // Defence in depth: the id whitelist already excludes separators and dots-only names.
    if (!path.startsWith(root + sep)) throw new Error('profile path escapes the profiles root')
    return path
  }

  /**
   * Launch a ready-to-use persistent context for one connection on `display`.
   * Protected so tests can substitute a fake browser.
   */
  protected async launchContext(connectionId: string, display: string): Promise<BrowserContext> {
    const profilePath = this.profilePath(connectionId)

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
    delete entry.idleTimer
    this.entries.delete(connectionId)
    // Registered in `closing` so a relaunch waits for the display to go away
    // instead of racing a stop() that would kill the new display.
    this.trackClosing(connectionId, this.xvfb.stop(connectionId))
  }

  /**
   * Fired by the idle timer. Under the entry lock, re-check that nobody used
   * or leased the browser since the timer fired; otherwise back off.
   */
  private async reclaim(connectionId: string, entry: PoolEntry, gen: number): Promise<void> {
    if (this.entries.get(connectionId) !== entry) return
    const unlock = await entry.lock.acquire()
    const stillIdle =
      this.entries.get(connectionId) === entry &&
      entry.idleGen === gen &&
      this.leaseCount(connectionId) === 0
    if (!stillIdle) {
      unlock()
      return
    }
    await this.closeEntry(entry, unlock)
  }

  private resetIdleTimer(connectionId: string): void {
    const entry = this.entries.get(connectionId)
    if (!entry) return
    clearTimeout(entry.idleTimer)
    delete entry.idleTimer
    entry.idleGen++
    if (this.leaseCount(connectionId) > 0) return
    const gen = entry.idleGen
    entry.idleTimer = setTimeout(() => {
      void this.reclaim(connectionId, entry, gen).catch(() => undefined)
    }, this.idleTimeoutMs)
  }
}
