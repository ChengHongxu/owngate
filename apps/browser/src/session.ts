// Session manager: wraps BrowserPool + XvfbManager, manages screencast stream tokens.

import { randomBytes } from 'node:crypto'
import {
  BrowserPool,
  XvfbManager,
  ProxyCredentialStore,
  checkLoginOnce,
  waitForLogin,
} from '@webridge/browser-runtime'
import type {
  BrowserEntry,
  BrowserPoolOptions,
  LoginCondition,
  LoginResult,
} from '@webridge/browser-runtime'
import { LoginStateTracker, type LoginStateSnapshot } from './login-state.js'
import type { ImportedCookie } from './cookies.js'

const STREAM_TOKEN_TTL_MS = 5 * 60 * 1000
/** Default login wait: matches the 15-minute idle cap on login sessions (§4.4.5). */
export const DEFAULT_LOGIN_WAIT_MS = 15 * 60 * 1000

export interface StartLoginOptions {
  qrSelector?: string
  /** How long to wait for the success condition, in ms. */
  deadlineMs?: number
  /** Without it nothing can prove success, so the wait can only end in timeout. */
  successWhen?: LoginCondition
}

interface StreamTokenEntry {
  connectionId: string
  expiresAt: number
}

interface LoginState {
  qrSelector?: string
  deadlineMs?: number
}

/**
 * Browser worker session manager.
 *
 * `egressProxyServer` (env BROWSER_EGRESS_PROXY, e.g. http://egress:3128) makes
 * every browser go through the egress proxy — design §4.4.1 requires it: the
 * container has no direct route out. When unset, browsers talk to the network
 * directly, which is only acceptable for local development.
 */
export class SessionManager {
  private readonly xvfb = new XvfbManager()
  /** One pool per profile base directory — BrowserPool appends `/<connectionId>`. */
  private readonly pools = new Map<string, BrowserPool>()
  /** Live entries, kept in sync with what the pools hand out. */
  private readonly entries = new Map<string, BrowserEntry>()
  private readonly streamTokens = new Map<string, StreamTokenEntry>()
  private readonly loginState = new Map<string, LoginState>()
  private readonly loginStatus = new LoginStateTracker()
  /**
   * Last success condition per connection. Outlives stopLogin so a later cookie
   * import can verify against it; dropped on closeSession.
   */
  private readonly successConditions = new Map<string, LoginCondition>()
  /** Per-connection proxy credentials, shared by every pool in this process. */
  private readonly proxyCredentials = new ProxyCredentialStore()

  constructor(
    private readonly defaultProfilesDir: string,
    private readonly egressProxyServer?: string,
  ) {}

  async openSession(connectionId: string, profilePath: string): Promise<{ session_id: string }> {
    const entry = await this.poolFor(profilePath || this.defaultProfilesDir).acquire(connectionId)
    this.entries.set(connectionId, entry)
    return { session_id: connectionId }
  }

  async closeSession(connectionId: string): Promise<void> {
    this.revokeStreamTokens(connectionId)
    this.loginState.delete(connectionId)
    this.loginStatus.clear(connectionId)
    this.successConditions.delete(connectionId)
    this.entries.delete(connectionId)
    await Promise.all(Array.from(this.pools.values()).map((pool) => pool.close(connectionId)))
  }

  /**
   * Open the login page and start watching for the success condition in the
   * background. Poll getLoginState for the outcome.
   */
  async startLogin(
    connectionId: string,
    url: string,
    options: StartLoginOptions = {},
  ): Promise<{ stream_token: string }> {
    const { qrSelector, deadlineMs, successWhen } = options
    const entry = await this.entry(connectionId)
    const page = entry.context.pages()[0] ?? (await entry.context.newPage())
    await page.goto(url)

    this.loginState.set(connectionId, {
      ...(qrSelector !== undefined ? { qrSelector } : {}),
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    })
    if (successWhen) this.successConditions.set(connectionId, successWhen)

    const { attemptId, signal } = this.loginStatus.begin(connectionId)
    void this.runLoginWait(
      entry,
      successWhen,
      deadlineMs ?? DEFAULT_LOGIN_WAIT_MS,
      signal,
    ).then((result) => this.loginStatus.settle(connectionId, attemptId, result))

    const token = randomBytes(32).toString('hex')
    this.streamTokens.set(token, {
      connectionId,
      expiresAt: Date.now() + STREAM_TOKEN_TTL_MS,
    })
    return { stream_token: token }
  }

  async stopLogin(connectionId: string): Promise<void> {
    this.revokeStreamTokens(connectionId)
    this.loginState.delete(connectionId)
    this.loginStatus.stop(connectionId)
  }

  getLoginState(connectionId: string): LoginStateSnapshot {
    return this.loginStatus.get(connectionId)
  }

  /**
   * Write cookies into the connection's context, then probe the success
   * condition once. `successWhen` falls back to the one from the last
   * startLogin; with neither, `verified` is false. A url_not_contains
   * condition is checked against the page as it is now, without reloading.
   */
  async importCookies(
    connectionId: string,
    cookies: ImportedCookie[],
    successWhen?: LoginCondition,
  ): Promise<{ imported: number; verified: boolean }> {
    const entry = await this.entry(connectionId)
    const condition = successWhen ?? this.successConditions.get(connectionId)
    if (successWhen) this.successConditions.set(connectionId, successWhen)

    // Same per-connection lock as /v1/check: do not change cookies under a running exec.
    const release = await entry.lock.acquire()
    let verified = false
    try {
      await entry.context.addCookies(cookies)
      if (condition) verified = (await checkLoginOnce(entry.context, condition)) !== null
    } finally {
      release()
    }

    if (verified) this.loginStatus.markSuccess(connectionId, 'cookie import verified')
    return { imported: cookies.length, verified }
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
    return this.loginState.get(connectionId)?.qrSelector
  }

  /** Acquire (creating if needed) the live browser entry for a connection. */
  async entry(connectionId: string): Promise<BrowserEntry> {
    const existing = this.getEntry(connectionId)
    if (existing) return existing
    const entry = await this.poolFor(this.defaultProfilesDir).acquire(connectionId)
    this.entries.set(connectionId, entry)
    return entry
  }

  /** Existing live entry, or undefined. Closed contexts are evicted. */
  getEntry(connectionId: string): BrowserEntry | undefined {
    const entry = this.entries.get(connectionId)
    if (!entry) return undefined
    try {
      entry.context.pages()
      return entry
    } catch {
      this.entries.delete(connectionId)
      return undefined
    }
  }

  getHealthStatus(): { browsers: { connection_id: string; display: string }[] } {
    return {
      browsers: this.xvfb.listActive().map((a) => ({
        connection_id: a.connectionId,
        display: a.display,
      })),
    }
  }

  async closeAll(): Promise<void> {
    this.streamTokens.clear()
    this.loginState.clear()
    this.loginStatus.clearAll()
    this.successConditions.clear()
    this.entries.clear()
    await Promise.all(Array.from(this.pools.values()).map((pool) => pool.closeAll()))
  }

  private poolFor(profilesDir: string): BrowserPool {
    const existing = this.pools.get(profilesDir)
    if (existing) return existing
    const options: BrowserPoolOptions =
      this.egressProxyServer !== undefined
        ? {
            proxy: {
              proxyServer: this.egressProxyServer,
              credentials: this.proxyCredentials,
            },
          }
        : {}
    const pool = new BrowserPool(this.xvfb, profilesDir, options)
    this.pools.set(profilesDir, pool)
    return pool
  }

  /** Never rejects: an error becomes a failed result, so the state ends in timeout. */
  private async runLoginWait(
    entry: BrowserEntry,
    successWhen: LoginCondition | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<LoginResult> {
    try {
      if (!successWhen) {
        await abortableDelay(timeoutMs, signal)
        return { success: false, reason: 'timeout (no success_when supplied, cannot detect login)' }
      }
      return await waitForLogin(entry.context, { success_when: successWhen }, timeoutMs, signal)
    } catch (e) {
      return { success: false, reason: `login check failed: ${(e as Error).message}` }
    }
  }

  private revokeStreamTokens(connectionId: string): void {
    for (const [token, entry] of this.streamTokens) {
      if (entry.connectionId === connectionId) this.streamTokens.delete(token)
    }
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
