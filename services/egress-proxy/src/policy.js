import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { domainToASCII } from 'node:url'
import net from 'node:net'

const MAX_TTL_MS = 60_000
const SKEW_MS = 30_000
const digest = value => createHash('sha256').update(value).digest()

export function normalizeDomain(value) {
  if (typeof value !== 'string' || value.length > 253 || value.includes('*')) return null
  const host = domainToASCII(value.toLowerCase().replace(/\.$/, ''))
  if (!host || net.isIP(host) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) return null
  return host
}

/** Registry entries are leases, never a fallback to accepting arbitrary secrets. */
export class PolicyRegistry {
  entries = new Map()
  constructor({ now = Date.now } = {}) { this.now = now }
  register(body) {
    const { connection_id: id, password, strict, allowed_domains: domains, ttl_ms: ttl = MAX_TTL_MS } = body ?? {}
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof password !== 'string' || !/^[a-f0-9]{64}$/.test(password)) throw new Error('invalid connection credentials')
    if (typeof strict !== 'boolean' || !Array.isArray(domains) || domains.length > 100 || domains.some(domain => !normalizeDomain(domain))) throw new Error('invalid domain policy')
    if (!Number.isInteger(ttl) || ttl < 1000 || ttl > MAX_TTL_MS) throw new Error('ttl_ms must be an integer in [1000, 60000]')
    const normalized = [...new Set(domains.map(normalizeDomain))].sort()
    if (strict && normalized.length === 0) throw new Error('strict policy requires allowed_domains')
    const hash = digest(password)
    const previous = this.entries.get(id)
    const same = previous && timingSafeEqual(previous.hash, hash) && previous.strict === strict && JSON.stringify(previous.domains) === JSON.stringify(normalized)
    if (previous && !same) this.revoke(id)
    const entry = same ? previous : { hash, strict, domains: normalized, sockets: new Set() }
    clearTimeout(entry.timer)
    entry.expiresAt = this.now() + ttl
    entry.timer = setTimeout(() => this.revoke(id), ttl)
    entry.timer.unref()
    this.entries.set(id, entry)
    return { ok: true, expires_at: entry.expiresAt }
  }
  revoke(id) {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    clearTimeout(entry.timer)
    for (const socket of entry.sockets) socket.destroy()
  }
  authenticate(username, password) {
    const entry = this.entries.get(username)
    if (!entry) return null
    if (entry.expiresAt <= this.now()) { this.revoke(username); return null }
    return typeof password === 'string' && timingSafeEqual(entry.hash, digest(password)) ? { username, entry } : null
  }
  allows(identity, hostname) {
    if (this.entries.get(identity.username) !== identity.entry || identity.entry.expiresAt <= this.now()) return false
    if (!identity.entry.strict) return true
    const host = normalizeDomain(hostname)
    return host !== null && identity.entry.domains.some(domain => host === domain || host.endsWith('.' + domain))
  }
  track(identity, socket) {
    if (this.entries.get(identity.username) !== identity.entry || identity.entry.expiresAt <= this.now()) { socket.destroy(); return false }
    identity.entry.sockets.add(socket)
    socket.once('close', () => identity.entry.sockets.delete(socket))
    return true
  }
  close() { for (const id of this.entries.keys()) this.revoke(id) }
}

export function makeControlVerifier(secret, now = Date.now) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('EGRESS_CONTROL_SECRET must contain at least 32 characters')
  const nonces = new Map()
  return (req, body) => {
    const ts = req.headers['x-og-ts'], nonce = req.headers['x-og-nonce'], sig = req.headers['x-og-sig']
    const time = now()
    for (const [key, expiry] of nonces) if (expiry <= time) nonces.delete(key)
    if (typeof ts !== 'string' || !/^\d{13}$/.test(ts) || Math.abs(Number(ts) - time) > SKEW_MS || typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce) || typeof sig !== 'string' || !/^[a-f0-9]{64}$/.test(sig) || nonces.has(nonce) || nonces.size >= 10_000) return false
    const expected = createHmac('sha256', secret).update(JSON.stringify([req.method.toUpperCase(), req.url, ts, nonce, body])).digest()
    if (!timingSafeEqual(expected, Buffer.from(sig, 'hex'))) return false
    nonces.set(nonce, Number(ts) + SKEW_MS + 1)
    return true
  }
}
