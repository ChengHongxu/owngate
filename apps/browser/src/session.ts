// Session manager: wraps BrowserPool + XvfbManager, manages screencast stream tokens

import { randomBytes } from 'node:crypto'
import { BrowserPool, XvfbManager } from '@webridge/browser-runtime'
import type { BrowserEntry } from '@webridge/browser-runtime'

const STREAM_TOKEN_TTL_MS = 5 * 60 * 1000

interface StreamTokenEntry {
  connectionId: string
  expiresAt: number
}

export class SessionManager {
  private pool: BrowserPool
  private xvfb: XvfbManager
  private streamTokens = new Map<string, StreamTokenEntry>()

  constructor(profilesDir: string) {
    this.xvfb = new XvfbManager()
    this.pool = new BrowserPool(this.xvfb, profilesDir)
  }

  async openSession(connectionId: string, profilePath: string): Promise<{ session_id: string }> {
    await this.pool.acquire(connectionId)
    return { session_id: connectionId }
  }

  async closeSession(connectionId: string): Promise<void> {
    this.revokeStreamTokensForConnection(connectionId)
    await this.pool.close(connectionId)
  }

  async startLogin(
    connectionId: string,
    url: string,
    qrSelector?: string,
    deadlineMs?: number,
  ): Promise<{ stream_token: string }> {
    const entry = await this.pool.acquire(connectionId)
    const page = entry.context.pages()[0] ?? await entry.context.newPage()
    await page.goto(url)

    const token = randomBytes(32).toString('hex')
    this.streamTokens.set(token, {
      connectionId,
      expiresAt: Date.now() + STREAM_TOKEN_TTL_MS,
    })

    return { stream_token: token }
  }

  async stopLogin(connectionId: string): Promise<void> {
    this.revokeStreamTokensForConnection(connectionId)
    const entry = this.getEntry(connectionId)
    if (!entry) return
    for (const page of entry.context.pages()) {
      try {
        await page.close()
      } catch {
        // ignore
      }
    }
  }

  resolveStreamToken(token: string): string | undefined {
    const entry = this.streamTokens.get(token)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.streamTokens.delete(token)
      return undefined
    }
    // One-time use
    this.streamTokens.delete(token)
    return entry.connectionId
  }

  getEntry(connectionId: string): BrowserEntry | undefined {
    // BrowserPool.acquire would create a new entry; we only want existing ones.
    // Access the private map is not available, so we track via a thin wrapper.
    return this._entries.get(connectionId)
  }

  async acquireEntry(connectionId: string): Promise<BrowserEntry> {
    const entry = await this.pool.acquire(connectionId)
    this._entries.set(connectionId, entry)
    return entry
  }

  getHealthStatus(): { browsers: { connection_id: string; display: string }[] } {
    return {
      browsers: this.xvfb.listActive().map((a) => ({
        connection_id: a.connectionId,
        display: a.display,
      })),
    }
  }

  private revokeStreamTokensForConnection(connectionId: string): void {
    for (const [token, entry] of this.streamTokens) {
      if (entry.connectionId === connectionId) {
        this.streamTokens.delete(token)
      }
    }
  }

  // Tracks live BrowserEntry refs by connectionId for WebSocket use
  private _entries = new Map<string, BrowserEntry>()
}
