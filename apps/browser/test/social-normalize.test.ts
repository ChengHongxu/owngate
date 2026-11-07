import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeFeed, normalizeProfile } from '../src/social/normalize.js'
import type { Platform } from '../src/social/types.js'

const fixture = (platform: Platform) => JSON.parse(readFileSync(new URL(`fixtures/social/${platform}.json`, import.meta.url), 'utf8'))

describe('social_feed_item response normalization', () => {
  it.each(['bilibili', 'xiaohongshu', 'zhihu', 'x'] as const)('normalizes %s stable identity, account, links and explicit zero without fabricated metrics', platform => {
    const result = normalizeFeed(platform, fixture(platform).feed)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]!
    expect(item.data.platform).toBe(platform)
    expect(item.data.author.id).not.toBeNull()
    expect(item.data.url).toMatch(/^https:\/\//)
    expect(item.data.metrics.likes).toBe(0)
    expect(item.data.metrics.comments).toBeGreaterThan(0)
    expect(item.fields['text']?.untrusted ?? item.fields['title']?.untrusted).toBe(true)
    if (platform !== 'x') {
      expect(item.data.metrics.views).toBeUndefined()
      expect(item.fields['metrics.views']?.status).toBe('unknown')
    }
  })

  it('reports malformed items separately while preserving usable records', () => {
    const result = normalizeFeed('bilibili', fixture('bilibili').feed)
    expect(result.errors).toEqual([{ index: 1, code: 'ITEM_PARSE_FAILED', reason: expect.stringContaining('缺少') }])
    expect(result.items[0]!.data.id).toBe('9001')
    expect(result.items[0]!.data.text).toBe('正常动态')
  })

  it('does not manufacture timestamps or convert compact display counts to numeric precision', () => {
    const body = fixture('xiaohongshu').feed
    body.data.items[0].note_card.interact_info.liked_count = '1.2万'
    const item = normalizeFeed('xiaohongshu', body).items[0]!
    expect(item.data.published_at).toBeNull()
    expect(item.fields['published_at']?.status).toBe('unknown')
    expect(item.data.metrics.likes).toBeUndefined()
    expect(item.fields['metrics.likes']?.status).toBe('unknown')
  })

  it('strips script markup from captured content and retains the real answer permalink', () => {
    const item = normalizeFeed('zhihu', fixture('zhihu').feed).items[0]!
    expect(item.data.url).toBe('https://www.zhihu.com/question/202/answer/101')
    expect(item.data.text).toBe('正常回答')
    expect(item.data.published_at).toBe('2023-11-14T22:13:20.000Z')
  })

  it('does not treat an arbitrary nested array as a valid feed response', () => {
    for (const platform of ['bilibili', 'xiaohongshu', 'zhihu', 'x'] as const) expect(() => normalizeFeed(platform, { unrelated: { items: [] } })).toThrow()
    expect(normalizeFeed('bilibili', { code: 0, data: { items: [], has_more: false } }).items).toEqual([])
  })

  it('maps B站 history and watchlater using page response fields without mutating the account', () => {
    expect(normalizeFeed('bilibili', fixture('bilibili').history, 'history.list').items[0]!.data.url).toContain('BV1history')
    expect(normalizeFeed('bilibili', fixture('bilibili').watchlater, 'watchlater.list').items[0]!.data.url).toContain('BV1later')
  })

  it.each(['bilibili', 'xiaohongshu', 'zhihu', 'x'] as const)('accepts only an identifiable current %s profile', platform => {
    const result = normalizeProfile(platform, fixture(platform).profile)
    expect(result.data['uid']).toBe(platform === 'bilibili' ? 42 : platform === 'xiaohongshu' ? 'xhs-42' : platform === 'zhihu' ? 'zhihu-42' : 'x-42')
    expect(result.data['nickname']).toBeTruthy()
    expect(() => normalizeProfile(platform, { unrelated: {} })).toThrow()
  })
})
