import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function signRuntime(secret: string, method: string, path: string, body: string) {
  const at = String(Date.now()), nonce = randomBytes(16).toString('hex');
  return { 'x-og-ts': at, 'x-og-nonce': nonce, 'x-og-sig': createHmac('sha256', secret).update(JSON.stringify([method, path, at, nonce, body])).digest('hex') };
}
export class RuntimeAuth {
  private nonces = new Map<string, number>();
  constructor(private readonly secret: string) {}
  verify(headers: Record<string, string | string[] | undefined>, method: string, path: string, body: string) {
    const at = headers['x-og-ts'], nonce = headers['x-og-nonce'], signature = headers['x-og-sig'], now = Date.now();
    if (typeof at !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string' || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature) || !Number.isFinite(Number(at)) || Math.abs(now - Number(at)) > 30_000) return false;
    for (const [key, expiry] of this.nonces) if (expiry < now) this.nonces.delete(key);
    const expected = createHmac('sha256', this.secret).update(JSON.stringify([method, path, at, nonce, body])).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')) || this.nonces.has(nonce) || this.nonces.size >= 10_000) return false;
    this.nonces.set(nonce, now + 30_000); return true;
  }
}
