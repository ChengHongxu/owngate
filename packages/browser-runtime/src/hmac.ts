// HMAC-SHA256 signing for server↔browser RPC (design doc §13.1)
// X-Wr-Sig = HMAC-SHA256(body, shared_secret) hex
// X-Wr-Ts  = Unix timestamp ms (±30s window)

import { createHmac, timingSafeEqual } from 'node:crypto'

const CLOCK_SKEW_MS = 30_000

export function signRequest(
  body: string,
  secret: string,
): { 'X-Wr-Sig': string; 'X-Wr-Ts': string } {
  const ts = String(Date.now())
  const sig = createHmac('sha256', secret).update(body).digest('hex')
  return { 'X-Wr-Sig': sig, 'X-Wr-Ts': ts }
}

export function verifyRequest(
  body: string,
  sig: string,
  ts: string,
  secret: string,
): boolean {
  const tsNum = Number(ts)
  if (!Number.isFinite(tsNum)) return false
  if (Math.abs(Date.now() - tsNum) > CLOCK_SKEW_MS) return false

  const expected = createHmac('sha256', secret).update(body).digest('hex')
  const expectedBuf = Buffer.from(expected, 'hex')
  const actualBuf = Buffer.from(sig, 'hex')
  if (expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}
