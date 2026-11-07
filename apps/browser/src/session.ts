// Session manager: wraps BrowserPool + XvfbManager, manages screencast stream tokens.

import { randomBytes } from 'node:crypto'
import {
  BrowserPool,
  XvfbManager,
  ProxyCredentialStore,
  EgressController,
  InvalidConnectionIdError,
  checkLoginOnce,
  waitForLogin,
} from '@owngate/browser-runtime'
import type {
  BrowserEntry,
  EgressPolicy,
  EgressControlConfig,
  BrowserPoolOptions,
  LoginCondition,
  LoginResult,
} from '@owngate/browser-runtime'
import { LoginStateTracker, type LoginStateSnapshot } from './login-state.js'
import type { ImportedCookie } from './cookies.js'
import { BrowserUnavailableError, CookieRejectedError } from './errors.js'

const STREAM_TOKEN_TTL_MS = 5 * 60 * 1000
/**
 * Longest login wait, and the default: a login session closes after 15
 * minutes (§4.4.5). The worker sees no input events in M1, so this counts
 * from the start of the login, not from the last input.
 */
export const DEFAULT_LOGIN_WAIT_MS = 15 * 60 * 1000
/** A lock waiter that keeps finding a closed entry gives up after this many tries. */
const MAX_STALE_RETRIES = 3

export interface StartLoginOptions {
  /** Any one holding means logged in (design §13.1). Required: without it a wait can only time out. */
  successWhen: readonly LoginCondition[]
  qrSelector?: string
  /** How long to wait for the success condition, in ms. Capped at DEFAULT_LOGIN_WAIT_MS. */
  deadlineMs?: number
}

export interface SessionManagerOptions {
  /** Browser idle reclaim; default the pool's 10 minutes. */
  idleTimeoutMs?: number
  egressControl?: EgressControlConfig
}

interface StreamTokenEntry {
  connectionId: string
  expiresAt: number
}

/**
 * Browser worker session manager.
 *
 * Profiles live at `<profilesDir>/<connection_id>`; the server never names a
 * path (design §13.1). `egressProxyServer` (env BROWSER_EGRESS_PROXY, e.g.
 * http://egress:3128) makes every browser go through the egress proxy —
 * design §4.4.1 requires it: the container has no direct route out. When
 * unset, browsers talk to the network directly, which is only acceptable for
 * local development.
 *
 * Leases (BrowserPool.hold) keep a browser from idle reclaim while a login
 * wait, a screencast socket, /v1/check or /v1/probe needs it.
 */
export class SessionManager {
  private readonly xvfb = new XvfbManager()
  /** Created on first use so subclasses can override createPool(). */
  private pool: BrowserPool | undefined
  private readonly streamTokens = new Map<string, StreamTokenEntry>()
  /** qr_selector of the login in progress, per connection. */
  private readonly qrSelectors = new Map<string, string>()
  private readonly loginStatus = new LoginStateTracker()
  /**
   * Last success conditions per connection. Outlive the login wait so a later
   * cookie import can verify against them; dropped on closeSession.
   */
  private readonly successConditions = new Map<string, readonly LoginCondition[]>()
  /** Closers of open screencast sockets, per connection. */
  private readonly screens = new Map<string, Set<() => void>>()
  /** Per-connection proxy credentials. */
  private readonly proxyCredentials = new ProxyCredentialStore()
  private readonly egress: EgressController | undefined
  private stopping = false
  private closing: Promise<void> | undefined

  constructor(
    private readonly profilesDir: string,
    private readonly egressProxyServer?: string,
    private readonly options: SessionManagerOptions = {},
  ) {
    if (egressProxyServer) {
      if (!options.egressControl) throw new Error('egress proxy requires authenticated control configuration')
      this.egress = new EgressController(options.egressControl, this.proxyCredentials, async (id) => {
        // Fail closed immediately, including tabs left open between RPCs.
        await this.pool?.get(id)?.context.close()
      })
    }
  }

  configureEgress(connectionId: string, policy: EgressPolicy): void { this.assertOpen(); this.egress?.configure(connectionId, policy) }

  async openSession(connectionId: string): Promise<{ session_id: string }> {
    await this.entry(connectionId)
    return { session_id: connectionId }
  }

  /** Ends any login, closes screencast sockets, then closes the browser after the running request. */
  async closeSession(connectionId: string): Promise<void> {
    this.loginStatus.clear(connectionId)
    this.endScreen(connectionId)
    this.successConditions.delete(connectionId)
    await this.getPool().close(connectionId)
    await this.egress?.revoke(connectionId)
    this.proxyCredentials.delete(connectionId)
  }

  /**
   * Open the login page and start watching for the success conditions in the
   * background. Poll getLoginState for the outcome. A lease is held from the
   * call until the wait ends, so idle reclaim cannot close the browser during
   * a long QR-code login.
   */
  async startLogin(
    connectionId: string,
    url: string,
    options: StartLoginOptions,
  ): Promise<{ stream_token: string }> {
    this.assertOpen()
    const { successWhen, qrSelector } = options
    const waitMs = Math.min(options.deadlineMs ?? DEFAULT_LOGIN_WAIT_MS, DEFAULT_LOGIN_WAIT_MS)
    const releaseLease = this.getPool().hold(connectionId)
    let handedOff = false
    try {
      // Same per-connection lock as /v1/check: do not navigate under a running
      // exec. Held for the navigation only; the wait below runs unlocked (it
      // only reads cookies and the URL).
      const { entry, attemptId, signal } = await this.withLockedEntry(connectionId, async (entry) => {
        const page = entry.context.pages()[0] ?? (await entry.context.newPage())
        await page.goto(url)
        this.assertOpen()
        // Marked pending before the lock is released, so a probe queued on the
        // lock sees the login and does not navigate away from it.
        return { entry, ...this.loginStatus.begin(connectionId) }
      })

      if (qrSelector !== undefined) this.qrSelectors.set(connectionId, qrSelector)
      else this.qrSelectors.delete(connectionId)
      this.successConditions.set(connectionId, successWhen)

      handedOff = true
      void this.runLoginWait(entry, successWhen, waitMs, signal)
        .then((result) => {
          // Success or timeout ends the login session: the screen closes (§4.4.3).
          if (this.loginStatus.settle(connectionId, attemptId, result)) this.endScreen(connectionId)
        })
        .finally(releaseLease)

      const token = randomBytes(32).toString('hex')
      this.streamTokens.set(token, {
        connectionId,
        expiresAt: Date.now() + STREAM_TOKEN_TTL_MS,
      })
      return { stream_token: token }
    } finally {
      if (!handedOff) releaseLease()
    }
  }

  async stopLogin(connectionId: string): Promise<void> {
    this.loginStatus.stop(connectionId)
    this.endScreen(connectionId)
  }

  getLoginState(connectionId: string): LoginStateSnapshot {
    return this.loginStatus.get(connectionId)
  }

  /** A remote login is waiting on this connection (/v1/probe must not navigate). */
  isLoginInProgress(connectionId: string): boolean {
    return this.loginStatus.isPending(connectionId)
  }

  /**
   * Write cookies into the connection's context, then probe the success
   * conditions once. `successWhen` falls back to the one from the last
   * startLogin; with neither, `logged_in` is false. A url_not_contains
   * condition is checked against the pages as they are now, without reloading.
   * Throws CookieRejectedError when the browser refuses the batch.
   */
  async importCookies(
    connectionId: string,
    cookies: ImportedCookie[],
    successWhen?: readonly LoginCondition[],
  ): Promise<{ logged_in: boolean }> {
    const conditions = successWhen ?? this.successConditions.get(connectionId)
    // Same per-connection lock as /v1/check: do not change cookies under a running exec.
    const loggedIn = await this.withLockedEntry(connectionId, async (entry) => {
      try {
        await entry.context.addCookies(cookies)
      } catch {
        // Drop the browser's text: it could quote a cookie value.
        throw new CookieRejectedError()
      }
      if (!conditions) return false
      return (await checkLoginOnce(entry.context, conditions)) !== null
    })
    if (successWhen) this.successConditions.set(connectionId, successWhen)

    if (loggedIn) {
      this.loginStatus.markSuccess(connectionId, 'cookie import verified')
      this.endScreen(connectionId)
    }
    return { logged_in: loggedIn }
  }

  /** One-time use: a resolved token is removed from the store. */
  resolveStreamToken(token: string): string | undefined {
    const entry = this.streamTokens.get(token)
    if (!entry) return undefined
    this.streamTokens.delete(token)
    if (Date.now() > entry.expiresAt) return undefined
    return entry.connectionId
  }

  getQrSelector(connectionId: string): string | undefined {
    return this.qrSelectors.get(connectionId)
  }

  /**
   * Register an open screencast socket. Holds a lease until the returned
   * detach function runs (idempotent); `close` is called when the login
   * session ends (success, timeout, stop, closeSession).
   */
  attachScreen(connectionId: string, close: () => void): () => void {
    this.assertOpen()
    const releaseLease = this.getPool().hold(connectionId)
    let set = this.screens.get(connectionId)
    if (!set) {
      set = new Set()
      this.screens.set(connectionId, set)
    }
    const mine = set
    mine.add(close)
    let detached = false
    return () => {
      if (detached) return
      detached = true
      mine.delete(close)
      if (mine.size === 0 && this.screens.get(connectionId) === mine) this.screens.delete(connectionId)
      releaseLease()
    }
  }

  /**
   * Acquire (creating if needed) the live browser entry for a connection.
   * Always goes through the pool: that resets its idle timer, shares a launch
   * already in flight, and relaunches after an idle reclaim.
   */
  async entry(connectionId: string): Promise<BrowserEntry> {
    this.assertOpen()
    return this.getPool().acquire(connectionId)
  }

  /** Lease + entry, relaunching a reclaimed browser on the same profile. */
  async lease(connectionId: string): Promise<{ entry: BrowserEntry; release: () => void }> {
    this.assertOpen()
    return this.getPool().lease(connectionId)
  }

  /**
   * Run `fn` holding a lease and the connection lock on a live entry. If the
   * entry was closed while this call waited for the lock (idle reclaim,
   * closeSession, crash), the lock is dropped and a fresh entry is acquired,
   * so `fn` never runs on a closed context. When `signal` aborts (deadline)
   * before `fn` starts, the lock is released without running it.
   *
   * Launch failures become BrowserUnavailableError. `fn` must not call
   * closeSession/pool.close for this connection: they wait for this lock.
   */
  async withLockedEntry<T>(
    connectionId: string,
    fn: (entry: BrowserEntry) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.assertOpen()
    const pool = this.getPool()
    const releaseLease = pool.hold(connectionId)
    try {
      for (let attempt = 0; ; attempt++) {
        this.assertOpen()
        signal?.throwIfAborted()
        let entry: BrowserEntry
        try {
          entry = await pool.acquire(connectionId)
        } catch (e) {
          if (e instanceof InvalidConnectionIdError) throw e
          throw new BrowserUnavailableError(`browser failed to start: ${(e as Error).message}`)
        }
        const unlock = await entry.lock.acquire()
        if (pool.get(connectionId) !== entry) {
          unlock()
          if (attempt + 1 >= MAX_STALE_RETRIES) {
            throw new BrowserUnavailableError('browser kept closing while the request waited')
          }
          continue
        }
        try {
          signal?.throwIfAborted()
          return await fn(entry)
        } finally {
          unlock()
        }
      }
    } finally {
      releaseLease()
    }
  }

  /** Existing live entry, or undefined. Does not launch a browser. */
  getEntry(connectionId: string): BrowserEntry | undefined {
    return this.getPool().get(connectionId)
  }

  /** Leases currently out for a connection (diagnostics and tests). */
  leaseCount(connectionId: string): number {
    return this.getPool().leaseCount(connectionId)
  }

  getHealthStatus(): { browsers: { connection_id: string; display: string }[] } {
    return {
      browsers: this.xvfb.listActive().map((a) => ({
        connection_id: a.connectionId,
        display: a.display,
      })),
    }
  }

  closeAll(): Promise<void> {
    if (this.closing) return this.closing
    this.stopping = true
    this.loginStatus.clearAll()
    for (const id of Array.from(this.screens.keys())) this.endScreen(id)
    this.streamTokens.clear()
    this.qrSelectors.clear()
    this.successConditions.clear()
    this.closing = (async () => {
      try { await this.pool?.closeAll() }
      finally { await this.egress?.close() }
    })()
    return this.closing
  }

  private assertOpen(): void {
    if (this.stopping) throw new BrowserUnavailableError('browser worker is shutting down')
  }
  private getPool(): BrowserPool {
    if (this.pool) return this.pool
    const options: BrowserPoolOptions = {
      ...(this.options.idleTimeoutMs !== undefined ? { idleTimeoutMs: this.options.idleTimeoutMs } : {}),
      ...(this.egressProxyServer !== undefined
        ? {
            proxy: {
              proxyServer: this.egressProxyServer,
              credentials: this.proxyCredentials,
              authorize: (id: string) => this.egress!.ensure(id),
            },
          }
        : {}),
    }
    this.pool = this.createPool(this.xvfb, this.profilesDir, options)
    return this.pool
  }

  /** Protected so tests can substitute a pool that launches a fake browser. */
  protected createPool(
    xvfb: XvfbManager,
    profilesDir: string,
    options: BrowserPoolOptions,
  ): BrowserPool {
    return new BrowserPool(xvfb, profilesDir, options)
  }

  /** Never rejects: an error becomes a failed result, so the state ends in timeout. */
  private async runLoginWait(
    entry: BrowserEntry,
    successWhen: readonly LoginCondition[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<LoginResult> {
    try {
      return await waitForLogin(entry.context, { success_when: successWhen }, timeoutMs, signal)
    } catch (e) {
      return { success: false, reason: `login check failed: ${(e as Error).message}` }
    }
  }

  /** The login session is over: no new screens, and open ones close. */
  private endScreen(connectionId: string): void {
    for (const [token, entry] of this.streamTokens) {
      if (entry.connectionId === connectionId) this.streamTokens.delete(token)
    }
    this.qrSelectors.delete(connectionId)
    const closers = this.screens.get(connectionId)
    if (!closers) return
    for (const close of Array.from(closers)) {
      try {
        close()
      } catch {
        // a socket that is already gone
      }
    }
  }
}
