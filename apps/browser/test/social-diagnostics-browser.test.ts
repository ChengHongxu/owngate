import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { BrowserDiagnostics } from '../src/diagnostics.js'
import { captureSocial } from '../src/social/capture.js'

describe.runIf(process.env['OWNGATE_REAL_BROWSER_TEST'] === '1')('real Chromium execution failure locations', () => {
  let browser: Browser
  beforeAll(async () => { browser = await chromium.launch({ headless: true, chromiumSandbox: true }) })
  afterAll(async () => { await browser?.close() })

  it('distinguishes a missing expected response from a parser failure without emitting query secrets', async () => {
    const context = await browser.newContext()
    await context.route('**/*', route => route.request().resourceType() === 'document'
      ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><body>Local history fixture</body>' }) : route.abort())
    const diagnostics = new BrowserDiagnostics()
    try {
      const result = await captureSocial(context, 'bilibili', 'history.list', { limit: 1 }, 200, undefined, { maxScrolls: 0 }, diagnostics)
      const steps = diagnostics.finish()
      expect(result.error?.code).toBe('PARSE_FAILED')
      expect(steps).toEqual([
        expect.objectContaining({ id: 'browser.auth', status: 'success' }),
        expect.objectContaining({ id: 'browser.navigate', status: 'success' }),
        expect.objectContaining({ id: 'browser.capture', status: 'error', code: 'PARSE_FAILED', detail: expect.stringContaining('/x/web-interface/history/cursor') }),
      ])
      expect(steps.some(step => step.id === 'browser.parse')).toBe(false)
    } finally { await context.close() }
  })

  it('marks parsing as failed when the page emits a recognized response with an unknown structure', async () => {
    const context = await browser.newContext()
    const endpoint = 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?w_rid=private-signature'
    await context.route('**/*', route => {
      if (route.request().url() === endpoint) return route.fulfill({ json: { code: 0, data: { unsupported: 'private-feed-body' } }, headers: { 'access-control-allow-origin': '*' } })
      return route.request().resourceType() === 'document'
        ? route.fulfill({ contentType: 'text/html', body: `<!doctype html><body><script>fetch(${JSON.stringify(endpoint)})</script></body>` }) : route.abort()
    })
    const diagnostics = new BrowserDiagnostics()
    try {
      const result = await captureSocial(context, 'bilibili', 'feed.list', { source: 'recommended', limit: 1 }, 300, undefined, { maxScrolls: 0 }, diagnostics)
      const steps = diagnostics.finish()
      expect(result.error?.code).toBe('PARSE_FAILED')
      expect(steps.find(step => step.id === 'browser.capture')).toMatchObject({ status: 'success', detail: expect.stringContaining('HTTP 200') })
      expect(steps.find(step => step.id === 'browser.parse')).toMatchObject({ status: 'error', code: 'PARSE_FAILED' })
      expect(JSON.stringify(steps)).not.toMatch(/private-signature|private-feed-body|w_rid|https:/)
    } finally { await context.close() }
  })

  it('stops at document HTTP failure and skips response capture rather than reporting a parser timeout', async () => {
    const context = await browser.newContext()
    await context.route('**/*', route => route.request().resourceType() === 'document'
      ? route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><body>Not found</body>' }) : route.abort())
    const diagnostics = new BrowserDiagnostics()
    try {
      const result = await captureSocial(context, 'bilibili', 'history.list', { limit: 1 }, 1000, undefined, { maxScrolls: 6 }, diagnostics)
      const steps = diagnostics.finish()
      expect(result.error?.code).toBe('UPSTREAM_ERROR')
      expect(result.error?.what_happened).toContain('HTTP 404')
      expect(steps).toEqual([
        expect.objectContaining({ id: 'browser.auth', status: 'success' }),
        expect.objectContaining({ id: 'browser.navigate', status: 'error', code: 'UPSTREAM_ERROR', detail: '站点页面返回 HTTP 404' }),
        expect.objectContaining({ id: 'browser.capture', status: 'skipped' }),
      ])
      expect(steps.some(step => step.id === 'browser.parse')).toBe(false)
    } finally { await context.close() }
  })

  it('marks response capture as failed when a recognized response body exceeds the reading limit', async () => {
    const context = await browser.newContext()
    const endpoint = 'https://api.bilibili.com/x/web-interface/history/cursor'
    await context.route('**/*', route => {
      if (route.request().url() === endpoint) return route.fulfill({
        contentType: 'application/json', body: JSON.stringify({ code: 0, data: { oversized: 'x'.repeat(5 * 1024 * 1024) } }),
        headers: { 'access-control-allow-origin': '*' },
      })
      return route.request().resourceType() === 'document'
        ? route.fulfill({ contentType: 'text/html', body: `<!doctype html><body><script>fetch(${JSON.stringify(endpoint)})</script></body>` }) : route.abort()
    })
    const diagnostics = new BrowserDiagnostics()
    try {
      const result = await captureSocial(context, 'bilibili', 'history.list', { limit: 1 }, 1000, undefined, { maxScrolls: 0 }, diagnostics)
      const steps = diagnostics.finish()
      expect(result.error?.code).toBe('PARSE_FAILED')
      expect(steps.find(step => step.id === 'browser.capture')).toMatchObject({
        status: 'error', code: 'PARSE_FAILED', detail: expect.stringContaining('响应体无法读取'),
      })
      expect(steps.some(step => step.id === 'browser.parse')).toBe(false)
      expect(JSON.stringify(steps)).not.toContain('oversized')
    } finally { await context.close() }
  })
})
