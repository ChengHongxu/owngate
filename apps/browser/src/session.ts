// Session manager: wraps BrowserPool + XvfbManager, manages screencast stream tokens.

import { randomBytes } from 'node:crypto'
import { BrowserPool, XvfbManager } from '@webridge/browser-runtime'
import type { BrowserEntry } from '@webridge/browser-runtime'

const STREAM_TOKEN_TTL_MS = 5 * 60 * 1000

interface StreamTokenEntry {
  connectionId: string
  expiresAt: number
}

interface LoginState {
  qrSelector?: string
  deadlineMs?: number
}

export class SessionManager {
  private readonly xvfb = new XvfbManager()
  /** One pool per profile base directory — BrowserPool appends `/<connectionId>`. */
  private readonly pools = new Map<string, BrowserPool>()
  /** Live entries, kept in sync with what the pools hand out. */
  private readonly entries = new Map<string, BrowserEntry>()
  private readonly streamTokens = new Map<string, StreamTokenEntry>()
  private readonly loginState = new Map<string, LoginState>()

  constructor(private readonly defaultProfilesDir: string) {}

  async openSession(connectionId: string, profilePath: string): Promise<{ session_id: string }> {
    const entry = await this.poolFor(profilePath || this.defaultProfilesDir).acquire(connectionId)
    this.entries.set(connectionId, entry)
    return { session_id: connectionId }
  }

  async closeSession(connectionId: string): Promise<void> {
    this.revokeStreamTokens(connectionId)
    this.loginState.delete(connectionId)
    this.entries.delete(connectionId)
    await Promise.all(Array.from(this.pools.values()).map((pool) => pool.close(connectionId)))
  }

  async startLogin(
    connectionId: string,
    url: string,
    qrSelector?: string,
    deadlineMs?: number,
  ): Promise<{ stream_token: string }> {
    const entry = await this.entry(connectionId)
    const page = entry.context.pages()[0] ?? (await entry.context.newPage())
    await page.goto(url)

    this.loginState.set(connectionId, {
      ...(qrSelector !== undefined ? { qrSelector } : {}),
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    })

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
    this.entries.clear()
    await Promise.all(Array.from(this.pools.values()).map((pool) => pool.closeAll()))
  }

  private poolFor(profilesDir: string): BrowserPool {
    const existing = this.pools.get(profilesDir)
    if (existing) return existing
    const pool = new BrowserPool(this.xvfb, profilesDir)
    this.pools.set(profilesDir, pool)
    return pool
  }

  private revokeStreamTokens(connectionId: string): void {
    for (const [token, entry] of this.streamTokens) {
      if (entry.connectionId === connectionId) this.streamTokens.delete(token)
    }
  }
}
