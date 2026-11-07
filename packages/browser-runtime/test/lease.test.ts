import { EventEmitter } from 'node:events'
import { describe, it, expect } from 'vitest'
import type { BrowserContext } from 'playwright'
import { BrowserPool } from '../src/pool.js'
import { XvfbManager } from '../src/xvfb.js'
import { InvalidConnectionIdError, isValidConnectionId } from '../src/connection-id.js'

// ── Fakes (same shape as pool.test.ts) ─────────────────────────────────────

class FakeXvfb extends XvfbManager {
  stopped: string[] = []
  stopDelayMs = 0
  override async start() {
    return { display: ':99', pid: 0 }
  }
  override async stop(connectionId: string) {
    if (this.stopDelayMs) await sleep(this.stopDelayMs)
    this.stopped.push(connectionId)
  }
}
const sharedXvfb = new FakeXvfb()

class FakeContext extends EventEmitter {
  closed = false
  pages() {
    return []
  }
  async close() {
    if (this.closed) return
    this.closed = true
    this.emit('close', this)
  }
  crash() {
    this.closed = true
    this.emit('close', this)
  }
}

class TestPool extends BrowserPool {
  contexts: FakeContext[] = []
  launches = 0
  protected override async launchContext(connectionId: string): Promise<BrowserContext> {
    // Exercise the real path builder: it must accept every id acquire() lets through.
    this.lastProfilePath = this.profilePath(connectionId)
    this.launches++
    const ctx = new FakeContext()
    this.contexts.push(ctx)
    return ctx as unknown as BrowserContext
  }
  lastProfilePath = ''
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Leases ────────────────────────────────────────────────────────────────

describe('BrowserPool leases', () => {
  it('does not idle-reclaim while a lease is held, and restarts the timer on the last release', async () => {
    const pool = new TestPool(sharedXvfb, '/tmp/profiles', { idleTimeoutMs: 20 })
    const { release } = await pool.lease('c1')
    const second = pool.hold('c1')
    expect(pool.leaseCount('c1')).toBe(2)

    await sleep(80)
    expect(pool.contexts[0]?.closed).toBe(false)

    release()
    await sleep(60)
    // One lease still out.
    expect(pool.contexts[0]?.closed).toBe(false)

    second()
    second() // idempotent
    expect(pool.leaseCount('c1')).toBe(0)
    await sleep(60)
    expect(pool.contexts[0]?.closed).toBe(true)
    expect(pool.get('c1')).toBeUndefined()
    await pool.closeAll()
  })

  it('a lease taken before the launch already blocks reclaim', async () => {
    const pool = new TestPool(sharedXvfb, '/tmp/profiles', { idleTimeoutMs: 20 })
    const release = pool.hold('c1')
    await pool.acquire('c1')
    await sleep(60)
    expect(pool.contexts[0]?.closed).toBe(false)
    release()
    await sleep(60)
    expect(pool.contexts[0]?.closed).toBe(true)
  })

  it('lease() gives the lease back when the launch fails', async () => {
    class Failing extends TestPool {
      protected override async launchContext(): Promise<BrowserContext> {
        throw new Error('no chromium')
      }
    }
    const pool = new Failing(sharedXvfb, '/tmp/profiles')
    await expect(pool.lease('c1')).rejects.toThrow('no chromium')
    expect(pool.leaseCount('c1')).toBe(0)
  })

  it('idle reclaim waits for the lock holder and closes afterwards', async () => {
    const pool = new TestPool(sharedXvfb, '/tmp/profiles', { idleTimeoutMs: 20 })
    const entry = await pool.acquire('c1')
    const unlock = await entry.lock.acquire()
    await sleep(60) // timer fired; reclaim is queued on the lock
    expect(pool.contexts[0]?.closed).toBe(false)
    unlock()
    await sleep(10)
    expect(pool.contexts[0]?.closed).toBe(true)
  })

  it('idle reclaim backs off when the browser was leased while it waited for the lock', async () => {
    const pool = new TestPool(sharedXvfb, '/tmp/profiles', { idleTimeoutMs: 20 })
    const entry = await pool.acquire('c1')
    const unlock = await entry.lock.acquire()
    await sleep(60)
    const release = pool.hold('c1')
    unlock()
    await sleep(10)
    expect(pool.contexts[0]?.closed).toBe(false)
    release()
    await pool.closeAll()
  })

  it('close() waits for the lock holder before closing the context', async () => {
    const pool = new TestPool(sharedXvfb, '/tmp/profiles')
    const entry = await pool.acquire('c1')
    const unlock = await entry.lock.acquire()
    let closed = false
    const closing = pool.close('c1').then(() => {
      closed = true
    })
    await sleep(20)
    expect(closed).toBe(false)
    expect(pool.contexts[0]?.closed).toBe(false)
    // New users no longer see the entry being closed.
    expect(pool.get('c1')).toBeUndefined()
    unlock()
    await closing
    expect(pool.contexts[0]?.closed).toBe(true)
  })

  it('a relaunch after a crash waits for the Xvfb stop', async () => {
    const xvfb = new FakeXvfb()
    xvfb.stopDelayMs = 30
    const pool = new TestPool(xvfb, '/tmp/profiles')
    await pool.acquire('c1')
    pool.contexts[0]?.crash()
    const t0 = performance.now()
    await pool.acquire('c1')
    expect(xvfb.stopped).toEqual(['c1'])
    expect(performance.now() - t0).toBeGreaterThanOrEqual(25)
    await pool.closeAll()
  })
})

// ── connection_id validation ──────────────────────────────────────────────

describe('connection id validation', () => {
  const bad = ['', '../etc', 'a/b', '..', '.', 'a b', 'x'.repeat(65), 'a\u0000b', 'é']

  it.each(bad)('pool rejects %j for acquire, lease and hold', async (id) => {
    const pool = new TestPool(sharedXvfb, '/tmp/profiles')
    await expect(pool.acquire(id)).rejects.toBeInstanceOf(InvalidConnectionIdError)
    await expect(pool.lease(id)).rejects.toBeInstanceOf(InvalidConnectionIdError)
    expect(() => pool.hold(id)).toThrow(InvalidConnectionIdError)
    expect(pool.launches).toBe(0)
    // close() of an invalid id is a harmless no-op.
    await expect(pool.close(id)).resolves.toBeUndefined()
  })

  it('accepts the server id format (16 hex chars) and UUIDs, and keeps the profile under the root', async () => {
    expect(isValidConnectionId('0123456789abcdef')).toBe(true)
    expect(isValidConnectionId('6f1c2a0e-1d2b-4c3d-9e8f-0a1b2c3d4e5f')).toBe(true)
    const pool = new TestPool(sharedXvfb, '/tmp/profiles')
    await pool.acquire('0123456789abcdef')
    expect(pool.lastProfilePath).toBe('/tmp/profiles/0123456789abcdef')
    await pool.closeAll()
  })
})

// ── Xvfb start dedupe ─────────────────────────────────────────────────────

describe('XvfbManager.start', () => {
  class CountingXvfb extends XvfbManager {
    spawns = 0
    protected override async spawnDisplay() {
      this.spawns++
      await sleep(20)
      return { display: `:${this.spawns}`, pid: 0 }
    }
  }

  it('shares one spawn between concurrent starts for the same connection', async () => {
    const x = new CountingXvfb()
    const [a, b] = await Promise.all([x.start('c1'), x.start('c1')])
    expect(x.spawns).toBe(1)
    expect(a).toEqual(b)
    expect(x.listActive()).toHaveLength(1)
    await x.stop('c1')
  })

  it('stop() during a start leaves no active display behind', async () => {
    const exits = process.listenerCount('exit')
    const x = new CountingXvfb()
    const starting = x.start('c1')
    await x.stop('c1')
    await starting
    expect(x.listActive()).toHaveLength(0)
    expect(process.listenerCount('exit')).toBe(exits)
  })

  it('attaches one exit cleanup only while it owns displays, removing it after the final stop', async () => {
    const exits = process.listenerCount('exit')
    const idle = Array.from({ length: 20 }, () => new CountingXvfb())
    expect(process.listenerCount('exit')).toBe(exits)
    const x = idle[0]!
    await Promise.all([x.start('c1'), x.start('c2')])
    expect(process.listenerCount('exit')).toBe(exits + 1)
    await x.stop('c1')
    expect(process.listenerCount('exit')).toBe(exits + 1)
    await x.stop('c2')
    expect(process.listenerCount('exit')).toBe(exits)
    await x.start('c3')
    expect(process.listenerCount('exit')).toBe(exits + 1)
    await x.stop('c3')
    expect(process.listenerCount('exit')).toBe(exits)
  })

  it('removes its exit cleanup after a failed launch', async () => {
    const exits = process.listenerCount('exit')
    class FailingXvfb extends XvfbManager {
      protected override async spawnDisplay(): Promise<never> { throw new Error('fixture launch failed') }
    }
    await expect(new FailingXvfb().start('c1')).rejects.toThrow('fixture launch failed')
    expect(process.listenerCount('exit')).toBe(exits)
  })
})
