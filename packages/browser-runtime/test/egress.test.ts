import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { EgressController, parseEgressPolicy } from '../src/egress.js'
import { ProxyCredentialStore } from '../src/proxy.js'

const secret = 'egress-fixture-secret-'.repeat(3)
const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))) })

describe('egress control lifecycle', () => {
  it('registers authenticated credentials with the real proxy and revokes them', async () => {
    const proxyUrl = new URL('../../../services/egress-proxy/src/main.js', import.meta.url).href
    const registryUrl = new URL('../../../services/egress-proxy/src/policy.js', import.meta.url).href
    const { createProxyServer } = await import(/* @vite-ignore */ proxyUrl)
    const { PolicyRegistry } = await import(/* @vite-ignore */ registryUrl)
    const registry = new PolicyRegistry()
    const server: Server = createProxyServer({ registry, controlSecret: secret })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected a local address')
    const credentials = new ProxyCredentialStore()
    let failed = false
    const controller = new EgressController({ baseUrl: `http://127.0.0.1:${address.port}`, secret }, credentials, async () => { failed = true })
    controller.configure('con_a', { allowed_domains: ['example.com'], strict: true })
    try {
      await controller.ensure('con_a')
      const identity = registry.authenticate('con_a', credentials.get('con_a').password)
      expect(identity).not.toBeNull()
      expect(registry.allows(identity, 'api.example.com')).toBe(true)
      expect(registry.allows(identity, 'other.com')).toBe(false)
      const original = credentials.get('con_a').password
      await controller.revoke('con_a')
      expect(registry.authenticate('con_a', original)).toBeNull()
      expect(credentials.get('con_a').password).not.toBe(original)
      expect(failed).toBe(false)
    } finally { await controller.close() }
  })

  it('fails closed after a reachable proxy becomes unavailable', async () => {
    const http = await import('node:http')
    let reachable = true
    const server = http.createServer((_request, response) => { response.writeHead(reachable ? 200 : 503); response.end() })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected a local address')
    const failed: string[] = []
    const controller = new EgressController({ baseUrl: `http://127.0.0.1:${address.port}`, secret }, new ProxyCredentialStore(), async id => { failed.push(id) })
    try {
      await expect(controller.ensure('con_a')).rejects.toThrow('policy is required')
      controller.configure('con_a', { allowed_domains: [], strict: false })
      await controller.ensure('con_a')
      reachable = false
      await expect(controller.ensure('con_a')).rejects.toThrow('network access refused')
      expect(failed).toEqual(['con_a'])
    } finally { await controller.close() }
  })

  it('revokes after an in-flight registration without reviving a closed connection', async () => {
    const http = await import('node:http')
    let release!: () => void, entered!: () => void
    const registrationEntered = new Promise<void>(resolve => { entered = resolve })
    const registrationReleased = new Promise<void>(resolve => { release = resolve })
    let active = false
    const events: string[] = []
    const server = http.createServer(async (request, response) => {
      request.resume()
      if (request.url === '/v1/policies/register') {
        events.push('register')
        entered()
        await registrationReleased
        active = true
      } else if (request.url === '/v1/policies/revoke') { events.push('revoke'); active = false }
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected a local address')
    const credentials = new ProxyCredentialStore()
    const controller = new EgressController({ baseUrl: `http://127.0.0.1:${address.port}`, secret }, credentials, async () => undefined)
    controller.configure('con_race', { allowed_domains: [], strict: false })
    const oldPassword = credentials.get('con_race').password
    try {
      const registration = controller.ensure('con_race')
      await registrationEntered
      const revocation = controller.revoke('con_race')
      expect(credentials.get('con_race').password).not.toBe(oldPassword)
      release()
      await Promise.all([registration, revocation])
      expect(events).toEqual(['register', 'revoke'])
      expect(active).toBe(false)
      await expect(controller.ensure('con_race')).rejects.toThrow('policy is required')
      expect(events).toEqual(['register', 'revoke'])
    } finally { release(); await controller.close() }
  })

  it('rejects malformed and empty strict policies', () => {
    expect(parseEgressPolicy({ strict: false, allowed_domains: [] })).toEqual({ strict: false, allowed_domains: [] })
    for (const allowed_domains of [[], ['*.example.com'], ['https://example.com'], ['127.0.0.1'], ['bad domain']]) {
      expect(() => parseEgressPolicy({ strict: true, allowed_domains })).toThrow()
    }
  })
})
