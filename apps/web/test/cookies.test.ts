import { describe, expect, it } from 'vitest'
import { parseCookieJson } from '../src/lib/cookies'

const SECRET = 'super-secret-cookie-value-123'

describe('parseCookieJson', () => {
  it('accepts an extension-exported array and keeps extra fields', () => {
    const text = JSON.stringify([
      { name: 'SESSDATA', value: SECRET, domain: '.bilibili.com', path: '/', httpOnly: true, expirationDate: 1 },
      { name: 'bili_jct', value: '', domain: '.bilibili.com' },
    ])
    const r = parseCookieJson(text)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.cookies).toHaveLength(2)
      expect(r.cookies[0]).toMatchObject({ name: 'SESSDATA', httpOnly: true, expirationDate: 1 })
    }
  })

  it('accepts a Playwright storageState object', () => {
    const r = parseCookieJson(JSON.stringify({ cookies: [{ name: 'a', value: 'b', domain: 'x.com' }], origins: [] }))
    expect(r).toMatchObject({ ok: true })
  })

  it('accepts url instead of domain', () => {
    const r = parseCookieJson(JSON.stringify([{ name: 'a', value: 'b', url: 'https://x.com' }]))
    expect(r.ok).toBe(true)
  })

  it.each([
    ['', '请粘贴'],
    ['   ', '请粘贴'],
    ['[]', '空的'],
    ['{"name":"a"}', 'JSON 数组'],
    ['"str"', 'JSON 数组'],
    ['[1]', '第 1 条不是对象'],
    ['[{"value":"v","domain":"x"}]', '第 1 条缺少 name'],
    ['[{"name":"a","domain":"x"}]', '第 1 条（a）缺少 value'],
    ['[{"name":"a","value":"v"}]', '第 1 条（a）缺少 domain'],
  ])('rejects %j', (text, hint) => {
    const r = parseCookieJson(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(hint)
  })

  it('reports the index of the first bad item', () => {
    const r = parseCookieJson(JSON.stringify([{ name: 'a', value: 'b', domain: 'x' }, { name: 'c', value: 'd' }]))
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('第 2 条') })
  })

  it('never echoes cookie values in errors', () => {
    const cases = [
      `[{"name":"a","value":"${SECRET}"`, // 截断的 JSON：原生报错会带原文
      JSON.stringify([{ name: 'a', value: SECRET }]),
      JSON.stringify([{ name: 'a', value: SECRET, domain: 'x' }, { value: SECRET, domain: 'x' }]),
      JSON.stringify({ value: SECRET }),
    ]
    for (const text of cases) {
      const r = parseCookieJson(text)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).not.toContain(SECRET)
    }
  })
})
