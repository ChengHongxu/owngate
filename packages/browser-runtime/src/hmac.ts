// HMAC-SHA256 signing for server↔browser RPC (design doc §13.1)
// Bind the body to its method, URL, timestamp and one-use nonce. The receiver
// additionally remembers accepted nonces until the timestamp window closes.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const CLOCK_SKEW_MS = 30_000

export interface RpcRequestTarget {
  method: string
  /** Path and query exactly as sent, without scheme or host. */
  path: string
}

export interface SignedRequestHeaders extends Record<string, string> {
  'X-Og-Sig': string
  'X-Og-Ts': string
  'X-Og-Nonce': string
}

function payload(body: string, target: RpcRequestTarget, ts: string, nonce: string): string {
  return JSON.stringify([target.method.toUpperCase(), target.path, ts, nonce, body])
}

export function signRequest(
  body: string,
  secret: string,
  target: RpcRequestTarget,
): SignedRequestHeaders {
  const ts = String(Date.now())
  const nonce = randomBytes(16).toString('hex')
  const sig = createHmac('sha256', secret).update(payload(body, target, ts, nonce)).digest('hex')
  return { 'X-Og-Sig': sig, 'X-Og-Ts': ts, 'X-Og-Nonce': nonce }
}

export function verifyRequest(
  body: string,
  sig: string,
  ts: string,
  secret: string,
  target: RpcRequestTarget,
  nonce: string,
): boolean {
  if (!/^\d{13}$/.test(ts) || !/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return false
  const tsNum = Number(ts)
  if (!Number.isFinite(tsNum)) return false
  if (Math.abs(Date.now() - tsNum) > CLOCK_SKEW_MS) return false

  const expected = createHmac('sha256', secret).update(payload(body, target, ts, nonce)).digest('hex')
  const expectedBuf = Buffer.from(expected, 'hex')
  const actualBuf = Buffer.from(sig, 'hex')
  if (expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}
