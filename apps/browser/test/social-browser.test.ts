import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { captureSocial } from '../src/social/capture.js'
import type { Platform } from '../src/social/types.js'

/** Opt in because ordinary unit CI does not install Chromium. These fixtures
 * execute real browser JS/response interception and never use live accounts. */
describe.runIf(process.env['OWNGATE_REAL_BROWSER_TEST'] === '1')('real Chromium social response interception (local fixtures)', () => {
  let browser: Browser
  beforeAll(async () => { browser = await chromium.launch({ headless: true, chromiumSandbox: true }) })
  afterAll(async () => { await browser?.close() })
  for (const platform of ['bilibili', 'xiaohongshu', 'zhihu', 'x'] as const) {
    const scenarios = [
      { capability: 'account.profile', source: 'recommended' },
      { capability: 'feed.list', source: 'recommended' },
      { capability: 'feed.list', source: 'following' },
      ...(platform === 'bilibili' ? [{ capability: 'history.list', source: 'recommended' }, { capability: 'watchlater.list', source: 'recommended' }] : []),
    ]
    for (const { capability, source } of scenarios) {
      it(`${platform} ${capability} ${source} uses the page request and normalizes its response`, async () => {
        const fixture = JSON.parse(readFileSync(new URL(`fixtures/social/${platform}.json`, import.meta.url), 'utf8'))
        const context = await browser.newContext()
        const own = capability === 'account.profile'
        const requestUrl: Record<Platform, string> = {
          bilibili: own ? 'https://api.bilibili.com/x/web-interface/nav' : capability === 'history.list' ? 'https://api.bilibili.com/x/web-interface/history/cursor' : capability === 'watchlater.list' ? 'https://api.bilibili.com/x/v2/history/toview/web' : source === 'following' ? 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all' : 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd',
          xiaohongshu: own ? 'https://edith.xiaohongshu.com/api/sns/web/v1/user/selfinfo' : 'https://edith.xiaohongshu.com/api/sns/web/v1/homefeed',
          zhihu: own ? 'https://www.zhihu.com/api/v4/me' : source === 'following' ? 'https://www.zhihu.com/api/v3/feed/following' : 'https://www.zhihu.com/api/v3/feed/topstory/recommend',
          x: `https://x.com/i/api/graphql/local-fixture/${own ? 'Viewer' : source === 'following' ? 'HomeLatestTimeline' : 'HomeTimeline'}`,
        }
        let intercepted = 0
        const navigations: string[] = []
        await context.route('**/*', async route => {
          if (route.request().url() === requestUrl[platform]) {
            intercepted++
            expect(route.request().resourceType()).toBe('fetch')
            return route.fulfill({ json: own ? fixture.profile : capability === 'history.list' ? fixture.history : capability === 'watchlater.list' ? fixture.watchlater : fixture.feed, headers: { 'access-control-allow-origin': '*' } })
          }
          if (route.request().resourceType() !== 'document') return route.abort()
          navigations.push(route.request().url())
          const script = `function load(){return fetch(${JSON.stringify(requestUrl[platform])},${JSON.stringify(platform === 'xiaohongshu' && !own ? { method: 'POST', body: JSON.stringify({ category: source === 'following' ? 'homefeed_follow' : 'homefeed_recommend' }) } : {})}).then(response => response.json()).then(() => {document.body.dataset.done='yes'})}load();`
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><body><h1>Local protocol fixture</h1><a data-testid="AppTabBar_Profile_Link" href="/fixture_self">Profile</a><button role="tab" onclick="load()">For you</button><button role="tab" onclick="load()">Following</button><button onclick="load()">关注</button><script>${script}</script></body>` })
        })
        try {
          const result = await captureSocial(context, platform, capability, own ? {} : { limit: 1, source }, 2000, undefined, { maxScrolls: 0, scrollWaitMs: 0 })
          // Bilibili's trailing-slash history URL is a real 404 and never emits
          // the history request; the no-slash entry redirects to /history.
          if (platform === 'bilibili' && capability === 'history.list') expect(navigations[0]).toBe('https://www.bilibili.com/account/history')
          expect(intercepted).toBeGreaterThan(0)
          expect(result.status, JSON.stringify(result)).toBe('ok')
          if (own) expect(result.data).toMatchObject({ nickname: expect.any(String) })
          else {
            expect(result.partial).toBe(platform === 'x' ? undefined : true)
            const data = result.data as { items: { platform: string }[] }
            expect(data.items).toHaveLength(1)
            expect(data.items[0]!.platform).toBe(platform)
            if (capability === 'feed.list' && (platform === 'bilibili' || platform === 'zhihu')) expect(result.item_errors).toHaveLength(1)
          }
          expect(context.pages()).toHaveLength(0)
        } finally { await context.close() }
      })
    }
  }

  it.each(['wbi/index', 'index'])('B站 recommended reads the page %s response without replaying its signed request or accepting other origins/feeds', async path => {
    const context = await browser.newContext()
    const feedUrl = `https://api.bilibili.com/x/web-interface/${path}/top/feed/rcmd?w_rid=fixture-signature&wts=1700000000`
    const unrelated = ['https://api.bilibili.com/x/web-interface/index/ogv/rcmd', 'https://api.bilibili.com.untrusted.invalid/x/web-interface/wbi/index/top/feed/rcmd']
    const feedBody = { code: 0, data: { item: [{ id: 100, bvid: 'BV1recommended', goto: 'av', title: '推荐样本', pubdate: 1700000000, owner: { mid: 42, name: '样本作者' }, stat: { view: 12, like: 0, reply: 7 } }] } }
    let capturedRequests = 0
    await context.route('**/*', async route => {
      const request = route.request()
      if (request.url() === feedUrl) {
        capturedRequests++
        expect(request.resourceType()).toBe('fetch')
        return route.fulfill({ json: feedBody, headers: { 'access-control-allow-origin': '*' } })
      }
      if (unrelated.includes(request.url())) return route.fulfill({ json: { code: -352 }, headers: { 'access-control-allow-origin': '*' } })
      if (request.resourceType() !== 'document') return route.abort()
      const script = `Promise.all(${JSON.stringify(unrelated)}.map(url=>fetch(url).then(response=>response.json()))).then(()=>fetch(${JSON.stringify(feedUrl)}));`
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><body><h1>Local recommended fixture</h1><script>${script}</script></body>` })
    })
    try {
      const result = await captureSocial(context, 'bilibili', 'feed.list', { limit: 1, source: 'recommended' }, 2000, undefined, { maxScrolls: 0, scrollWaitMs: 0 })
      expect(result.status, JSON.stringify(result)).toBe('ok')
      expect(result.data).toMatchObject({ items: [{ id: 'BV1recommended', url: 'https://www.bilibili.com/video/BV1recommended', metrics: { likes: 0, comments: 7, views: 12 } }] })
      expect(capturedRequests).toBe(1)
      expect(result.fields?.['has_more']?.status).toBe('unknown')
      expect(context.pages()).toHaveLength(0)
    } finally { await context.close() }
  })
})
