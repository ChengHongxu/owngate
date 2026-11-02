// TOTP (RFC 6238) and base32 (RFC 4648) helpers.
// Pure functions with no DB access, so they are unit-testable in isolation.
// Design doc D8: TOTP is the fallback second factor for admins without a passkey.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Encode raw bytes to unpadded uppercase base32 (the form authenticator apps expect). */
export function base32Encode(buf: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * Decode base32 to bytes. Tolerant of lowercase, spaces, hyphens and '=' padding,
 * which users commonly copy out of QR-code fallback text.
 */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  if (clean.length === 0) return Buffer.alloc(0);

  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`base32: invalid character ${JSON.stringify(ch)}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // Any leftover bits must be zero padding, otherwise the input was truncated.
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) {
    throw new Error('base32: non-zero trailing bits');
  }
  return Buffer.from(out);
}

/** Generate a fresh 160-bit (20 byte) TOTP secret, base32-encoded. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * HOTP value (RFC 4226) for the given key and moving factor.
 * Defaults to SHA-1 / 6 digits, which every authenticator app supports.
 */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export interface TotpOptions {
  /** Time step in seconds (RFC 6238 default 30). */
  stepSeconds?: number;
  /** Code length (default 6). */
  digits?: number;
  /** Accepted +/- step window (default 1, i.e. 30s either side). */
  window?: number;
}

/** TOTP code for a base32 secret at a Unix timestamp in seconds. */
export function totpAt(secretBase32: string, epochSeconds: number, options: TotpOptions = {}): string {
  const step = options.stepSeconds ?? 30;
  const digits = options.digits ?? 6;
  const counter = Math.floor(epochSeconds / step);
  return hotp(base32Decode(secretBase32), counter, digits);
}

/** Verify a user-supplied TOTP code against the current time, within the configured window. */
export function verifyTotpCode(
  secretBase32: string,
  code: string,
  epochSeconds: number = Math.floor(Date.now() / 1000),
  options: TotpOptions = {},
): boolean {
  const step = options.stepSeconds ?? 30;
  const digits = options.digits ?? 6;
  const window = options.window ?? 1;
  const candidate = code.replace(/\s/g, '');
  if (!/^\d+$/.test(candidate) || candidate.length !== digits) return false;

  const key = base32Decode(secretBase32);
  const counter = Math.floor(epochSeconds / step);
  const supplied = Buffer.from(candidate, 'utf8');
  let matched = false;
  for (let offset = -window; offset <= window; offset++) {
    if (counter + offset < 0) continue;
    const expected = Buffer.from(hotp(key, counter + offset, digits), 'utf8');
    // Compare every candidate so the loop duration does not reveal which step matched.
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) {
      matched = true;
    }
  }
  return matched;
}

/** Build the otpauth:// URL that authenticator apps consume. */
export function buildOtpauthUrl(params: {
  issuer: string;
  accountName: string;
  secretBase32: string;
  digits?: number;
  stepSeconds?: number;
}): string {
  const digits = params.digits ?? 6;
  const step = params.stepSeconds ?? 30;
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.accountName)}`;
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(step),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
