import type { Server } from 'node:http'
import type { BrowserPoolOptions, XvfbManager } from '@owngate/browser-runtime'
import { describe, expect, it } from 'vitest'
import { buildBrowserServer } from '../src/main.js'
import { SessionManager } from '../src/session.js'
import { FakePool, FakeWorld, SECRET, fakeXvfb } from './helpers.js'

class ProxySessions extends SessionManager {
  readonly world = new FakeWorld()
  constructor(baseUrl: string, secret: string) { super('/profiles-fixture', baseUrl, { egressControl: { baseUrl, secret } }) }
  protected override createPool(_xvfb: XvfbManager, directory: string, options: BrowserPoolOptions) { return new FakePool(fakeXvfb, directory, options, this.world) }
}

describe('server → worker → authenticated egress registration', () => {
  it('requires a policy, re-registers a reused context after lost proxy state, revokes on close, and refuses a broken control plane', async () => {
    process.env['BROWSER_RPC_SECRET'] = SECRET
    const proxyModule = new URL('../../../services/egress-proxy/src/main.js', import.meta.url).href
    const registryModule = new URL('../../../services/egress-proxy/src/policy.js', import.meta.url).href
    const { createProxyServer } = await import(/* @vite-ignore */ proxyModule)
    const { PolicyRegistry } = await import(/* @vite-ignore */ registryModule)
    const secret = 'egress-rpc-fixture-secret-'.repeat(3), registry = new PolicyRegistry()
    const proxy: Server = createProxyServer({ registry, controlSecret: secret })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const proxyAddress = proxy.address()
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('expected a local proxy address')
    const sessions = new ProxySessions(`http://127.0.0.1:${proxyAddress.port}`, secret)
    const { app } = await buildBrowserServer({ sessionManager: sessions, exec: async () => ({ status: 'ok', data: { uid: 42 } }) })
    const moduleUrl = new URL('../../server/src/browser-client.ts', import.meta.url).href
    const { createBrowserClient } = await import(/* @vite-ignore */ moduleUrl)
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('expected a local worker address')
    const client = createBrowserClient({ baseUrl: `http://127.0.0.1:${address.port}`, secret: SECRET })
    const policy = { strict: true, allowed_domains: ['bilibili.com'] }
    try {
      await expect(client.openSession('egress-fixture')).rejects.toThrow('policy is required')
      expect(sessions.world.launched).toHaveLength(0)
      await client.openSession('egress-fixture', policy)
      expect(registry.entries.has('egress-fixture')).toBe(true)
      registry.revoke('egress-fixture')
      expect(registry.entries.has('egress-fixture')).toBe(false)
      await expect(client.check({ connection_id: 'egress-fixture', connector_id: 'bilibili', exec_id: 'after-proxy-restart', capability: 'account.profile', params: {}, egress_policy: policy })).resolves.toMatchObject({ status: 'ok' })
      expect(registry.entries.has('egress-fixture')).toBe(true)
      expect(sessions.world.launched).toHaveLength(1)
      await client.closeSession('egress-fixture')
      expect(registry.entries.has('egress-fixture')).toBe(false)
      await client.openSession('egress-fixture', policy)
      const current = sessions.world.launched.at(-1)!.ctx
      proxy.closeAllConnections()
      await new Promise<void>(resolve => proxy.close(() => resolve()))
      await expect(client.check({ connection_id: 'egress-fixture', connector_id: 'bilibili', exec_id: 'control-unreachable', capability: 'account.profile', params: {}, egress_policy: policy })).resolves.toMatchObject({ status: 'error', error: { code: 'BROWSER_UNAVAILABLE' } })
      expect(current.closed).toBe(true)
      expect(sessions.getEntry('egress-fixture')).toBeUndefined()
    } finally {
      await app.close(); await sessions.closeAll()
      registry.close(); proxy.closeAllConnections(); proxy.close()
    }
  })
})
