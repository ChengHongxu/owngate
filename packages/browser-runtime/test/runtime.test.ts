import { describe, it, expect } from 'vitest'
import { signRequest, verifyRequest } from '../src/hmac.js'
import { AsyncMutex } from '../src/mutex.js'

describe('HMAC request signing', () => {
  const secret = 'test-shared-secret'
  const body = JSON.stringify({ connection_id: 'conn-1', capability: 'account.profile' })

  it('signs and verifies a fresh request', () => {
    const { 'X-Wr-Sig': sig, 'X-Wr-Ts': ts } = signRequest(body, secret)
    expect(verifyRequest(body, sig, ts, secret)).toBe(true)
  })

  it('rejects a body that was tampered with after signing', () => {
    const { 'X-Wr-Sig': sig, 'X-Wr-Ts': ts } = signRequest(body, secret)
    expect(verifyRequest(body + ' ', sig, ts, secret)).toBe(false)
  })

  it('rejects a signature made with a different secret', () => {
    const { 'X-Wr-Sig': sig, 'X-Wr-Ts': ts } = signRequest(body, 'other-secret')
    expect(verifyRequest(body, sig, ts, secret)).toBe(false)
  })

  it('rejects a timestamp outside the ±30s window', () => {
    const { 'X-Wr-Sig': sig } = signRequest(body, secret)
    const staleTs = String(Date.now() - 60_000)
    expect(verifyRequest(body, sig, staleTs, secret)).toBe(false)
  })

  it('rejects a non-numeric timestamp', () => {
    const { 'X-Wr-Sig': sig } = signRequest(body, secret)
    expect(verifyRequest(body, sig, 'not-a-number', secret)).toBe(false)
  })

  it('rejects a signature of the wrong length without throwing', () => {
    expect(verifyRequest(body, 'abcd', String(Date.now()), secret)).toBe(false)
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
