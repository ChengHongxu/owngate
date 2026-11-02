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

export class BrowserPool {
  private entries = new Map<string, BrowserEntry & { idleTimer: NodeJS.Timeout }>()
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
    return this.create(connectionId)
  }

  release(connectionId: string): void {
    // Marks as idle by (re)starting the idle timer; does NOT close the context.
    this.resetIdleTimer(connectionId)
  }

  async close(connectionId: string): Promise<void> {
    const entry = this.entries.get(connectionId)
    if (!entry) return
    clearTimeout(entry.idleTimer)
    this.entries.delete(connectionId)
    try {
      await entry.context.close()
    } catch {
      // ignore — context may already be closed
    }
    await this.xvfb.stop(connectionId)
  }

  async closeAll(): Promise<void> {
    const ids = Array.from(this.entries.keys())
    await Promise.all(ids.map((id) => this.close(id)))
  }

  private async create(connectionId: string): Promise<BrowserEntry> {
    const { display } = await this.xvfb.start(connectionId)
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
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })

    const entry: BrowserEntry & { idleTimer: NodeJS.Timeout } = {
      context,
      display,
      connectionId,
      lock: new AsyncMutex(),
      idleTimer: this.startIdleTimer(connectionId),
      // Spread rather than `proxyUsername: proxyCreds?.username`: under
      // exactOptionalPropertyTypes an explicit undefined is not assignable to an
      // optional `string` property. Username only — never log the password.
      ...(proxyCreds ? { proxyUsername: proxyCreds.username } : {}),
    }
    this.entries.set(connectionId, entry)
    return entry
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
