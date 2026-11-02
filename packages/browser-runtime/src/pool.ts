// One BrowserContext per connection, launched in headed mode on its Xvfb display.
// Idle timeout: 10 minutes (configurable). Connection-level serialization via async mutex.

import { chromium, type BrowserContext } from 'playwright'
import { AsyncMutex } from './mutex.js'
import { XvfbManager } from './xvfb.js'

export interface BrowserEntry {
  context: BrowserContext
  display: string
  connectionId: string
  lock: AsyncMutex
}

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000

export class BrowserPool {
  private entries = new Map<string, BrowserEntry & { idleTimer: NodeJS.Timeout }>()
  private idleTimeoutMs: number

  constructor(
    private readonly xvfb: XvfbManager,
    private readonly profilesDir: string,
    options?: { idleTimeoutMs?: number },
  ) {
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
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

    const context = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        `--display=${display}`,
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
