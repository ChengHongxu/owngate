// Unit tests for the pure TOTP / base32 helpers (apps/server/src/auth/totp.ts).
// The RFC 6238 vectors use an ASCII secret "12345678901234567890"; its base32
// encoding is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.

import { describe, it, expect } from 'vitest'
import {
  base32Decode,
  base32Encode,
  buildOtpauthUrl,
  generateTotpSecret,
  hotp,
  totpAt,
  verifyTotpCode,
} from '../src/auth/totp.js'

const RFC_SECRET_ASCII = '12345678901234567890'
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

// RFC 6238 appendix B, SHA-1 rows (8-digit output).
const RFC_VECTORS: ReadonlyArray<readonly [number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
]

describe('base32', () => {
  it('encodes the RFC 6238 secret to the known base32 form', () => {
    expect(base32Encode(Buffer.from(RFC_SECRET_ASCII, 'utf8'))).toBe(RFC_SECRET_BASE32)
  })

  it('round-trips arbitrary bytes', () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80, 0xaa, 0x55])
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true)
  })

  it('round-trips empty and single-byte inputs', () => {
    expect(base32Decode(base32Encode(Buffer.alloc(0))).length).toBe(0)
    const one = Buffer.from([0x42])
    expect(base32Decode(base32Encode(one)).equals(one)).toBe(true)
  })

  it('decodes the classic example string, ignoring case and padding', () => {
    // "JBSWY3DPEHPK3PXP" is the canonical base32 example: "Hello!" + 4 bytes.
    const decoded = base32Decode('jbsw y3dp ehpk 3pxp=')
    expect(decoded.toString('hex')).toBe('48656c6c6f21deadbeef')
    expect(decoded.subarray(0, 6).toString('utf8')).toBe('Hello!')
  })

  it('rejects invalid characters', () => {
    expect(() => base32Decode('ABC1')).toThrow(/invalid character/)
    expect(base32Decode('').length).toBe(0)
  })
})

describe('HOTP / TOTP (RFC 6238 vectors, SHA-1)', () => {
  for (const [t, expected] of RFC_VECTORS) {
    it(`matches the 8-digit vector at T=${t}`, () => {
      const secret = Buffer.from(RFC_SECRET_ASCII, 'utf8')
      expect(hotp(secret, Math.floor(t / 30), 8)).toBe(expected)
    })
  }

  it('produces the 6-digit code 94287082 -> 287082 at T=59', () => {
    expect(totpAt(RFC_SECRET_BASE32, 59)).toBe('287082')
  })

  it('accepts the current code and the +/-1 step window', () => {
    const t = 59
    const code = totpAt(RFC_SECRET_BASE32, t)
    expect(verifyTotpCode(RFC_SECRET_BASE32, code, t)).toBe(true)
    expect(verifyTotpCode(RFC_SECRET_BASE32, code, t + 30)).toBe(true)
    expect(verifyTotpCode(RFC_SECRET_BASE32, code, t - 30)).toBe(true)
  })

  it('rejects codes outside the window', () => {
    const t = 59
    const code = totpAt(RFC_SECRET_BASE32, t)
    expect(verifyTotpCode(RFC_SECRET_BASE32, code, t + 120)).toBe(false)
    expect(verifyTotpCode(RFC_SECRET_BASE32, code, t - 120)).toBe(false)
  })

  it('rejects malformed codes without throwing', () => {
    expect(verifyTotpCode(RFC_SECRET_BASE32, '', 59)).toBe(false)
    expect(verifyTotpCode(RFC_SECRET_BASE32, 'abcdef', 59)).toBe(false)
    expect(verifyTotpCode(RFC_SECRET_BASE32, '12345', 59)).toBe(false)
    expect(verifyTotpCode(RFC_SECRET_BASE32, '1234567', 59)).toBe(false)
  })

  it('tolerates spaces inside the submitted code', () => {
    expect(verifyTotpCode(RFC_SECRET_BASE32, '287 082', 59)).toBe(true)
  })
})

describe('secret generation and otpauth URL', () => {
  it('generates 160-bit base32 secrets that decode to 20 bytes', () => {
    const secret = generateTotpSecret()
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(base32Decode(secret).length).toBe(20)
    expect(secret).not.toBe(generateTotpSecret())
  })

  it('builds a scannable otpauth:// URL', () => {
    const url = buildOtpauthUrl({
      issuer: 'owngate',
      accountName: 'admin@example.com',
      secretBase32: RFC_SECRET_BASE32,
    })
    const parsed = new URL(url)
    expect(parsed.protocol).toBe('otpauth:')
    expect(parsed.hostname).toBe('totp')
    expect(parsed.pathname).toBe('/owngate:admin%40example.com')
    expect(parsed.searchParams.get('secret')).toBe(RFC_SECRET_BASE32)
    expect(parsed.searchParams.get('issuer')).toBe('owngate')
    expect(parsed.searchParams.get('digits')).toBe('6')
    expect(parsed.searchParams.get('period')).toBe('30')
  })
})
