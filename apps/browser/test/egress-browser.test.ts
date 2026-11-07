import { createServer, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { EgressController, ProxyCredentialStore } from '@owngate/browser-runtime'

const listen = (server: Server) => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server: Server) => { const address = server.address(); if (!address || typeof address === 'string') throw new Error('expected a TCP address'); return address.port }

describe.runIf(process.env['OWNGATE_REAL_BROWSER_TEST'] === '1')('real Chromium with authenticated egress (local fixture)', () => {
  it('uses registered credentials and denies off-domain, loopback bypass and revoked credentials', async () => {
    const proxyModule = new URL('../../../services/egress-proxy/src/main.js', import.meta.url).href
    const registryModule = new URL('../../../services/egress-proxy/src/policy.js', import.meta.url).href
    const { createProxyServer } = await import(/* @vite-ignore */ proxyModule)
    const { PolicyRegistry } = await import(/* @vite-ignore */ registryModule)
    const target = createServer((_request, response) => { response.end('<h1>Local proxy fixture</h1>') })
    await listen(target)
    const registry = new PolicyRegistry(), secret = 'local-browser-egress-secret-'.repeat(3)
    // Explicit test seam only. Production resolveAndCheck rejects loopback.
    const proxy: Server = createProxyServer({ registry, controlSecret: secret, check: async (host: string) => host === 'target.test' ? { allowed: true, ip: '127.0.0.1' } : { allowed: false } })
    await listen(proxy)
    const baseUrl = `http://127.0.0.1:${port(proxy)}`, credentials = new ProxyCredentialStore()
    const controller = new EgressController({ baseUrl, secret }, credentials, async () => {})
    controller.configure('browser-fixture', { strict: true, allowed_domains: ['target.test'] })
    await controller.ensure('browser-fixture')
    const browser = await chromium.launch({ headless: true, chromiumSandbox: true, proxy: { server: baseUrl, ...credentials.get('browser-fixture'), bypass: '<-loopback>' } })
    try {
      const page = await browser.newPage()
      await page.goto(`http://target.test:${port(target)}`)
      expect(await page.locator('h1').textContent()).toBe('Local proxy fixture')
      expect((await page.goto('http://other.test/'))!.status()).toBe(403)
      expect((await page.goto(`http://127.0.0.1:${port(target)}`))!.status()).toBe(403)
      await controller.revoke('browser-fixture')
      expect((await page.goto(`http://target.test:${port(target)}/revoked`))!.status()).toBe(407)
    } finally {
      await browser.close(); await controller.close(); registry.close()
      await Promise.all([target, proxy].map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
    }
  })
})
