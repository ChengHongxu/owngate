import { describe, it, expect } from 'vitest'
import { signRequest, verifyRequest } from '../src/hmac.js'
import { AsyncMutex } from '../src/mutex.js'

describe('HMAC request signing', () => {
  const secret = 'test-shared-secret'
  const body = JSON.stringify({ connection_id: 'conn-1', capability: 'account.profile' })
  const target = { method: 'POST', path: '/v1/check' }
  const signed = () => signRequest(body, secret, target)

  it('signs and verifies a fresh request', () => {
    const h = signed()
    expect(verifyRequest(body, h['X-Og-Sig'], h['X-Og-Ts'], secret, target, h['X-Og-Nonce'])).toBe(true)
  })

  it('binds body, method, path, timestamp and nonce', () => {
    const h = signed()
    const verify = (value = body, route = target, ts = h['X-Og-Ts'], nonce = h['X-Og-Nonce']) =>
      verifyRequest(value, h['X-Og-Sig'], ts, secret, route, nonce)
    expect(verify(body + ' ')).toBe(false)
    expect(verify(body, { ...target, method: 'DELETE' })).toBe(false)
    expect(verify(body, { ...target, path: '/v1/session/close' })).toBe(false)
    expect(verify(body, target, String(Number(h['X-Og-Ts']) + 1))).toBe(false)
    expect(verify(body, target, h['X-Og-Ts'], '00'.repeat(16))).toBe(false)
  })

  it('uses a fresh nonce on every signing call', () => {
    expect(signed()['X-Og-Nonce']).not.toBe(signed()['X-Og-Nonce'])
  })

  it('rejects a signature made with a different secret', () => {
    const h = signRequest(body, 'other-secret', target)
    expect(verifyRequest(body, h['X-Og-Sig'], h['X-Og-Ts'], secret, target, h['X-Og-Nonce'])).toBe(false)
  })

  it('rejects stale, invalid timestamps and malformed signatures', () => {
    const h = signed()
    for (const ts of [String(Date.now() - 60_000), 'not-a-number']) {
      expect(verifyRequest(body, h['X-Og-Sig'], ts, secret, target, h['X-Og-Nonce'])).toBe(false)
    }
    expect(verifyRequest(body, 'abcd', h['X-Og-Ts'], secret, target, h['X-Og-Nonce'])).toBe(false)
    expect(verifyRequest(body, 'zz'.repeat(32), h['X-Og-Ts'], secret, target, h['X-Og-Nonce'])).toBe(false)
  })
})

describe('AsyncMutex', () => {
  it('allows immediate acquire when unlocked', async () => {
    const m = new AsyncMutex()
    const release = await m.acquire()
    expect(typeof release).toBe('function')
    release()
  })

  it('serializes concurrent holders in FIFO order', async () => {
    const m = new AsyncMutex()
    const order: number[] = []

    const first = await m.acquire()
    const secondP = m.acquire().then((release) => {
      order.push(2)
      release()
    })
    const thirdP = m.acquire().then((release) => {
      order.push(3)
      release()
    })

    order.push(1)
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual([1])
    first()

    await Promise.all([secondP, thirdP])
    expect(order).toEqual([1, 2, 3])
  })

  it('releases the lock when the last waiter finishes', async () => {
    const m = new AsyncMutex()
    const release = await m.acquire()
    release()
    // Should acquire immediately again
    const release2 = await m.acquire()
    expect(typeof release2).toBe('function')
    release2()
  })
})
