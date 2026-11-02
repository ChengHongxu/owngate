import { EventEmitter } from 'node:events'
import { describe, it, expect } from 'vitest'
import type { BrowserContext } from 'playwright'
import { BrowserPool } from '../src/pool.js'
import { XvfbManager } from '../src/xvfb.js'

// ── Fakes ─────────────────────────────────────────────────────────────────

/** Xvfb that never spawns anything. */
class FakeXvfb extends XvfbManager {
  started: string[] = []
  stopped: string[] = []
  override async start(connectionId: string) {
    this.started.push(connectionId)
    return { display: ':99', pid: 0 }
  }
  override async stop(connectionId: string) {
    this.stopped.push(connectionId)
  }
}

/** Mirrors Playwright: close() emits 'close' before it resolves. */
class FakeContext extends EventEmitter {
  closed = false
  constructor(private readonly closeDelayMs = 0) {
    super()
  }
  pages() {
    return []
  }
  async close() {
    if (this.closeDelayMs) await sleep(this.closeDelayMs)
    if (this.closed) return
    this.closed = true
    this.emit('close', this)
  }
  /** The browser went away on its own (crash, window closed). */
  crash() {
    this.closed = true
    this.emit('close', this)
  }
}

class TestPool extends BrowserPool {
  launches = 0
  contexts: FakeContext[] = []
  launchDelayMs = 0
  closeDelayMs = 0
  failNext = false
  /** Launched contexts not yet closed. */
  openNow = 0
  maxOpen = 0

  protected override async launchContext(): Promise<BrowserContext> {
    this.launches++
    await sleep(this.launchDelayMs)
    if (this.failNext) {
      this.failNext = false
      throw new Error('launch failed')
    }
    const ctx = new FakeContext(this.closeDelayMs)
    this.openNow++
    this.maxOpen = Math.max(this.maxOpen, this.openNow)
    ctx.on('close', () => {
      this.openNow--
    })
    this.contexts.push(ctx)
    return ctx as unknown as BrowserContext
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('BrowserPool.acquire', () => {
  it('launches once for concurrent cold-start acquires and shares the entry', async () => {
    const pool = new TestPool(new FakeXvfb(), '/tmp/profiles')
    pool.launchDelayMs = 20
    const [a, b, c] = await Promise.all([
      pool.acquire('c1'),
      pool.acquire('c1'),
      pool.acquire('c1'),
    ])
    expect(pool.launches).toBe(1)
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(b.lock).toBe(a.lock)
    await pool.closeAll()
  })

  it('launches separately for different connections', async () => {
    const pool = new TestPool(new FakeXvfb(), '/tmp/profiles')
    const [a, b] = await Promise.all([pool.acquire('c1'), pool.acquire('c2')])
    expect(pool.launches).toBe(2)
    expect(a).not.toBe(b)
    await pool.closeAll()
  })

  it('rejects all waiters on a failed launch, then retries on the next acquire', async () => {
    const xvfb = new FakeXvfb()
    const pool = new TestPool(xvfb, '/tmp/profiles')
    pool.launchDelayMs = 10
    pool.failNext = true
    const results = await Promise.allSettled([pool.acquire('c1'), pool.acquire('c1')])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(pool.launches).toBe(1)
    expect(xvfb.stopped).toEqual(['c1'])

    const entry = await pool.acquire('c1')
    expect(pool.launches).toBe(2)
    expect(entry.context).toBe(pool.contexts[0])
    await pool.closeAll()
  })

  it('relaunches after the idle timeout closes the browser', async () => {
    const pool = new TestPool(new FakeXvfb(), '/tmp/profiles', { idleTimeoutMs: 20 })
    const first = await pool.acquire('c1')
    await sleep(60)
    expect(pool.contexts[0]?.closed).toBe(true)
    const second = await pool.acquire('c1')
    expect(second).not.toBe(first)
    expect(pool.launches).toBe(2)
    await pool.closeAll()
  })

  it('drops an entry whose context closed on its own', async () => {
    const xvfb = new FakeXvfb()
    const pool = new TestPool(xvfb, '/tmp/profiles')
    const first = await pool.acquire('c1')
    pool.contexts[0]?.crash()
    expect(xvfb.stopped).toEqual(['c1'])
    const second = await pool.acquire('c1')
    expect(second).not.toBe(first)
    expect(pool.launches).toBe(2)
    await pool.closeAll()
  })

  it('waits for a close in progress before relaunching the same profile', async () => {
    const pool = new TestPool(new FakeXvfb(), '/tmp/profiles')
    pool.closeDelayMs = 30
    await pool.acquire('c1')
    const closing = pool.close('c1')
    await pool.acquire('c1')
    await closing
    // Never two live browsers on one profile.
    expect(pool.maxOpen).toBe(1)
    expect(pool.launches).toBe(2)
    await pool.closeAll()
  })

  it('close() during a cold start closes the browser that was being launched', async () => {
    const pool = new TestPool(new FakeXvfb(), '/tmp/profiles')
    pool.launchDelayMs = 20
    const acquiring = pool.acquire('c1')
    await pool.close('c1')
    await acquiring
    expect(pool.contexts[0]?.closed).toBe(true)
    expect(pool.openNow).toBe(0)
  })
})
