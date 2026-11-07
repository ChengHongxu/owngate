// Manages one Xvfb virtual display per connection.
// Uses display numbers starting from :10 to avoid conflict with :99 used in tests.

import { spawn } from 'node:child_process'

interface DisplayEntry {
  display: string
  pid: number
}

export class XvfbManager {
  private entries = new Map<string, DisplayEntry>()
  /**
   * Starts in flight. Concurrent start() calls for one connection share the
   * promise, so one connection never ends up with two displays (and a leaked
   * Xvfb process).
   */
  private starting = new Map<string, Promise<DisplayEntry>>()
  private nextDisplay = 10
  private activeStarts = 0
  private cleanupAttached = false
  private readonly cleanupOnExit = () => {
    for (const entry of this.entries.values()) killQuietly(entry.pid)
  }

  private attachExitCleanup(): void {
    if (this.cleanupAttached) return
    this.cleanupAttached = true
    process.on('exit', this.cleanupOnExit)
  }

  private releaseExitCleanupIfIdle(): void {
    if (!this.cleanupAttached || this.entries.size || this.activeStarts) return
    process.off('exit', this.cleanupOnExit)
    this.cleanupAttached = false
  }

  async start(connectionId: string): Promise<{ display: string; pid: number }> {
    const existing = this.entries.get(connectionId)
    if (existing) return existing
    const inflight = this.starting.get(connectionId)
    if (inflight) return inflight

    this.activeStarts++
    this.attachExitCleanup()
    const started = this.spawnDisplay()
      .then((entry) => {
        // stop() during the start removed the marker: do not resurrect the entry.
        if (this.starting.get(connectionId) === started) {
          this.entries.set(connectionId, entry)
        } else {
          killQuietly(entry.pid)
        }
        return entry
      })
      .finally(() => {
        if (this.starting.get(connectionId) === started) this.starting.delete(connectionId)
        this.activeStarts--
        this.releaseExitCleanupIfIdle()
      })
    this.starting.set(connectionId, started)
    return started
  }

  /** Spawn one Xvfb and wait until it accepts clients. Protected for tests. */
  protected async spawnDisplay(): Promise<DisplayEntry> {
    const displayNum = this.nextDisplay++
    const display = `:${displayNum}`

    const xvfb = spawn('Xvfb', [
      display,
      '-screen', '0', '1280x960x24',
      '-nolisten', 'tcp',
    ], { detached: false })

    const pid = xvfb.pid
    if (pid === undefined) {
      throw new Error(`Failed to spawn Xvfb for display ${display}`)
    }

    // Wait for Xvfb to be ready by polling xdpyinfo
    const MAX_ATTEMPTS = 20
    const POLL_INTERVAL_MS = 500
    let ready = false

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await sleep(POLL_INTERVAL_MS)
      const ok = await checkDisplay(display)
      if (ok) {
        ready = true
        break
      }
    }

    if (!ready) {
      try {
        process.kill(pid)
      } catch {
        // ignore
      }
      throw new Error(
        `Xvfb on display ${display} did not become ready within ${MAX_ATTEMPTS * POLL_INTERVAL_MS}ms`,
      )
    }

    return { display, pid }
  }

  async stop(connectionId: string): Promise<void> {
    const inflight = this.starting.get(connectionId)
    if (inflight) {
      // Let the start finish, then kill what it spawned (see start()).
      this.starting.delete(connectionId)
      await inflight.catch(() => undefined)
    }
    const entry = this.entries.get(connectionId)
    if (entry) {
      this.entries.delete(connectionId)
      killQuietly(entry.pid)
    }
    this.releaseExitCleanupIfIdle()
  }

  getDisplay(connectionId: string): string | undefined {
    return this.entries.get(connectionId)?.display
  }

  listActive(): Array<{ connectionId: string; display: string; pid: number }> {
    return Array.from(this.entries.entries()).map(([connectionId, entry]) => ({
      connectionId,
      display: entry.display,
      pid: entry.pid,
    }))
  }
}

function killQuietly(pid: number): void {
  if (pid <= 0) return
  try {
    process.kill(pid)
  } catch {
    // ignore — process may already be gone
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function checkDisplay(display: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('xdpyinfo', ['-display', display], { stdio: 'ignore' })
    proc.on('close', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
}
