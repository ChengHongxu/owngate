import { isIP } from 'node:net'
import { signRequest } from './hmac.js'
import { ProxyCredentialStore } from './proxy.js'
import { assertConnectionId } from './connection-id.js'

export interface EgressPolicy { allowed_domains: string[]; strict: boolean }
export interface EgressControlConfig { baseUrl: string; secret: string; timeoutMs?: number; renewMs?: number }

export function parseEgressPolicy(value: unknown): EgressPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('egress_policy must be an object')
  const object = value as Record<string, unknown>
  if (typeof object['strict'] !== 'boolean' || !Array.isArray(object['allowed_domains']) || object['allowed_domains'].length > 100) throw new Error('egress_policy requires strict and allowed_domains')
  const domains = object['allowed_domains'].map((domain: unknown) => {
    if (typeof domain !== 'string' || domain.length > 253 || isIP(domain) !== 0 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain)) throw new Error('egress_policy contains an invalid domain')
    return domain.toLowerCase()
  })
  if (object['strict'] && domains.length === 0) throw new Error('strict egress policy requires allowed_domains')
  return { strict: object['strict'], allowed_domains: [...new Set(domains)].sort() }
}

/** Short-lived proxy leases. Every acquire must confirm the control plane is
 * reachable; an unavailable/restarted proxy never causes a direct fallback. */
export class EgressController {
  private policies = new Map<string, EgressPolicy>()
  private timers = new Map<string, NodeJS.Timeout>()
  private operations = new Map<string, Promise<void>>()
  constructor(private readonly config: EgressControlConfig, private readonly credentials: ProxyCredentialStore, private readonly onFailure: (id: string) => Promise<void>) {
    if (config.secret.length < 32) throw new Error('EGRESS_CONTROL_SECRET must contain at least 32 characters')
    const url = new URL(config.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid egress control URL')
  }
  configure(id: string, policy: EgressPolicy): void {
    assertConnectionId(id)
    const normalized = parseEgressPolicy(policy)
    if (JSON.stringify(this.policies.get(id)) !== JSON.stringify(normalized)) this.policies.set(id, normalized)
  }
  ensure(id: string): Promise<void> {
    assertConnectionId(id)
    return this.enqueue(id, () => this.register(id))
  }
  private async register(id: string): Promise<void> {
    const policy = this.policies.get(id)
    if (!policy) throw new Error('egress policy is required before opening this connection')
    try {
      await this.post('/v1/policies/register', { connection_id: id, password: this.credentials.get(id).password, ...policy, ttl_ms: 60_000 })
      if (this.policies.get(id) !== policy) return
      clearTimeout(this.timers.get(id))
      const timer = setTimeout(() => {
        this.timers.delete(id)
        void this.ensure(id).catch(() => undefined)
      }, this.config.renewMs ?? 20_000)
      timer.unref()
      this.timers.set(id, timer)
    } catch {
      clearTimeout(this.timers.get(id))
      this.timers.delete(id)
      await this.onFailure(id).catch(() => undefined)
      throw new Error('egress control unavailable; browser network access refused')
    }
  }
  async revoke(id: string): Promise<void> {
    assertConnectionId(id)
    clearTimeout(this.timers.get(id)); this.timers.delete(id)
    this.policies.delete(id)
    this.credentials.delete(id)
    await this.enqueue(id, () => this.post('/v1/policies/revoke', { connection_id: id }))
  }
  async close(): Promise<void> {
    const ids = [...this.policies.keys()]
    await Promise.allSettled(ids.map(id => this.revoke(id)))
  }
  private enqueue(id: string, operation: () => Promise<void>): Promise<void> {
    const result = (this.operations.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation)
    this.operations.set(id, result)
    const forget = () => { if (this.operations.get(id) === result) this.operations.delete(id) }
    void result.then(forget, forget)
    return result
  }
  private async post(path: string, payload: unknown): Promise<void> {
    const body = JSON.stringify(payload)
    const response = await fetch(this.config.baseUrl.replace(/\/$/, '') + path, {
      method: 'POST', headers: { 'content-type': 'application/json', ...signRequest(body, this.config.secret, { method: 'POST', path }) },
      body, signal: AbortSignal.timeout(this.config.timeoutMs ?? 2000),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error('egress policy registration refused') }
    await response.body?.cancel()
  }
}
