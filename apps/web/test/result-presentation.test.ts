import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Envelope, ResultPresentation } from '../src/lib/api'
import { ResultData } from '../src/components/ResultData'
import { buildResultView, MAX_VISIBLE_ROWS, presentationPath, safeResultLink, type CollectionNode, type ResultNode, type ValueNode } from '../src/lib/result-presentation'

const source = { connection_id: 'fixture', connection_label: '示例连接', capability_id: 'custom.read' }
function envelope(data: unknown, options: Partial<Envelope> = {}): Envelope {
  return { outcome: 'success', data, fields: {}, source, error: null, data_time: '2026-11-03T08:00:00Z', queried_at: '2026-11-03T08:00:00Z', cache: null, warnings: [], ...options }
}
function descendants(nodes: ResultNode[]): ResultNode[] {
  return nodes.flatMap(node => [node, ...(node.kind === 'object' ? descendants(node.children) : node.kind === 'collection' ? descendants(node.rows)
    : node.kind === 'feed' ? [node.author, node.title, node.body, node.date, node.link, ...node.metrics] : [])])
}
function values(nodes: ResultNode[]): ValueNode[] { return descendants(nodes).filter((node): node is ValueNode => node.kind === 'value') }
function collection(nodes: ResultNode[]): CollectionNode {
  const found = descendants(nodes).find((node): node is CollectionNode => node.kind === 'collection')
  if (!found) throw new Error('expected collection')
  return found
}

describe('declarative result presentation', () => {
  it('uses schema labels and explicit prominence while runtime units override even with an empty string', () => {
    const schema = { type: 'object', properties: { credits: { type: 'number', title: '可用点数', 'x-unit': 'USD', 'x-sensitivity': 'financial' } } }
    for (const unit of ['', 'quota', 'CNY']) {
      const view = buildResultView(envelope({ credits: 1e-22 }, { fields: { credits: { status: 'expired', unit } } }), schema)
      expect(values(view.nodes)[0]).toMatchObject({ label: '可用点数', text: '1e-22', unit, status: 'expired', prominent: true })
    }
    expect(values(buildResultView(envelope({ credits: 2 }), schema, { type: 'stats', fields: [{ path: '$.credits', label: '本期余额', prominent: false }] }).nodes)[0])
      .toMatchObject({ label: '本期余额', prominent: false, unit: 'USD' })
    expect(values(buildResultView(envelope({ arbitrary: 7 })).nodes)[0]?.unit).toBe('')
  })

  it('unwraps the OpenAPI result object without losing its state and metadata paths', () => {
    const schema = { type: 'object', properties: { result: { type: 'object', properties: { user: { type: 'object', title: '账户', properties: { name: { type: 'string', title: '名称' } } }, credits: { type: 'number', 'x-unit': 'USD' } } } } }
    const view = buildResultView(envelope({ result: { user: { name: '示例用户' }, credits: 5 } }, { fields: { 'result.credits': { status: 'expired', unit: 'quota' } } }), schema)
    expect(view.nodes.map(node => node.path)).toEqual(['result.user', 'result.credits'])
    expect(values(view.nodes)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'result.user.name', label: '名称', text: '示例用户' }),
      expect.objectContaining({ path: 'result.credits', text: '5', unit: 'quota', status: 'expired' }),
    ]))
  })

  it('automatically renders nested records and primitive collections instead of only their sizes', () => {
    const view = buildResultView(envelope({ result: { rows: [{ id: 'A', owner: { name: '作者' }, active: false }, { id: 'B', owner: { name: '另一个作者' } }], tags: ['one', 'two'], summary: { count: 0 } } }))
    const tables = descendants(view.nodes).filter((node): node is CollectionNode => node.kind === 'collection')
    expect(tables.map(node => [node.path, node.mode, node.shown])).toEqual([['result.rows', 'table', 2], ['result.tags', 'list', 2]])
    expect(values(view.nodes).map(node => node.text)).toEqual(expect.arrayContaining(['作者', '另一个作者', 'A', 'B', '否', 'one', 'two', '0']))
  })

  it('preserves arbitrary JSON property keys in automatic tables without widening public binding paths', () => {
    const data = { rows: [{ 中文: '实际名称', 123: 8, 'a.b': '字面字段', a: { b: '嵌套字段' } }] }
    const schema = { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { 中文: { title: '中文名称' }, 123: { title: '数字属性', 'x-unit': 'quota' }, 'a.b': { title: '含点属性' } } } } } }
    const view = buildResultView(envelope(data), schema)
    expect(values(view.nodes).map(node => node.text)).toEqual(expect.arrayContaining(['实际名称', '8', '字面字段', '嵌套字段']))
    expect(values(view.nodes).find(node => node.text === '8')).toMatchObject({ label: '数字属性', unit: 'quota' })
    expect(presentationPath('中文')).toBeUndefined()
    expect(presentationPath('123')).toBeUndefined()
    expect(presentationPath('a.b')).toEqual(['a', 'b'])
  })

  it('keeps actual zero, false, empty text, null, missing, unknown and unavailable distinct', () => {
    const schema = { type: 'object', properties: Object.fromEntries(['zero', 'disabled', 'empty', 'nil', 'missing', 'unknown', 'failed'].map(key => [key, {}])) }
    const view = buildResultView(envelope({ zero: 0, disabled: false, empty: '', nil: null, unknown: 19, failed: 20 }, { outcome: 'partial', fields: { unknown: { status: 'unknown', reason: '未获得授权字段' }, failed: { status: 'unavailable', reason: '接口超时' } } }), schema)
    expect(values(view.nodes).map(node => [node.path, node.text, node.status])).toEqual([
      ['zero', '0', 'ok'], ['disabled', '否', 'ok'], ['empty', '空文本', 'ok'], ['nil', '无值', 'null'],
      ['missing', '未提供', 'missing'], ['unknown', '未知', 'unknown'], ['failed', '暂不可用', 'unavailable'],
    ])
    expect(values(view.nodes).find(node => node.path === 'failed')?.reason).toBe('接口超时')
  })

  it.each(['redacted', 'unknown', 'unavailable'])('masks %s collection ancestors before reading children or returning their count', status => {
    const data = { result: { items: [{ secret: 'never disclose' }, { secret: 'also hidden' }] } }
    for (const presentation of [undefined, { type: 'table', items: '$.result.items' } as ResultPresentation, { type: 'stats', fields: [{ path: 'result.items.secret' }] } as ResultPresentation]) {
      const view = buildResultView(envelope(data, { fields: { result: { status, reason: '祖先字段状态' } } }), {}, presentation)
      expect(descendants(view.nodes).some(node => node.kind === 'collection')).toBe(false)
      expect(values(view.nodes).every(node => node.status === status && node.reason === '祖先字段状态')).toBe(true)
      expect(JSON.stringify(view)).not.toContain('never disclose')
    }
  })

  it('does not infer columns or render schema secrets from a redacted row', () => {
    const view = buildResultView(envelope({ rows: [{ private_shape: 'hidden' }, { public_field: 'shown' }] }, { fields: { 'rows[0]': { status: 'redacted' } } }))
    const table = collection(view.nodes)
    expect(table.columns.map(column => column.label)).toEqual(['public_field'])
    expect(JSON.stringify(view)).not.toContain('private_shape')
    expect(values(view.nodes)[0]).toMatchObject({ text: '已隐藏', status: 'redacted' })
    const secret = buildResultView(envelope({ token: 'secret value', credentials: { key: 'secret nested value' }, marker: '[REDACTED]' }), { type: 'object', properties: { token: { 'x-secret': true }, credentials: { writeOnly: true } } })
    expect(values(secret.nodes).map(node => node.text)).toEqual(['已隐藏', '已隐藏', '已隐藏'])
    expect(JSON.stringify(secret)).not.toContain('secret value')
  })

  it('normalizes both bracket and dot metadata paths inside records', () => {
    const view = buildResultView(envelope({ rows: [{ credits: 4 }, { credits: 5 }] }, { fields: { '$.rows[0].credits': { status: 'unavailable' }, 'rows.1.credits': { status: 'expired', unit: 'quota' } } }))
    expect(values(view.nodes).map(node => [node.text, node.status, node.unit])).toEqual([['暂不可用', 'unavailable', ''], ['5', 'expired', 'quota']])
  })

  it('supports table columns and list fields relative to each selected item', () => {
    const data = { result: { rows: [{ profile: { name: '客户A' }, score: 0, internal: 'omit' }] } }
    const table = collection(buildResultView(envelope(data), {}, { type: 'table', items: '$.result.rows', columns: [{ path: 'profile.name', label: '客户' }, { path: '$.score', label: '积分', format: 'number' }] }).nodes)
    expect(table.columns.map(column => column.label)).toEqual(['客户', '积分'])
    expect(values(table.rows).map(node => [node.path, node.text])).toEqual([['result.rows.0.profile.name', '客户A'], ['result.rows.0.score', '0']])
    const list = collection(buildResultView(envelope(data), {}, { type: 'list', items: 'result.rows', fields: [{ path: 'profile.name', label: '客户' }] }).nodes)
    expect(list.mode).toBe('list')
    expect(values(list.rows).map(node => node.text)).toEqual(['客户A'])
  })

  it('applies root field bindings to primitive list items', () => {
    const view = buildResultView(envelope({ rows: ['https://example.com/item', 'javascript:alert(1)'] }), {}, { type: 'list', items: 'rows', fields: [{ path: '$', label: '来源', format: 'link' }] })
    expect(values(view.nodes).map(node => [node.label, node.text, node.href])).toEqual([
      ['来源', 'https://example.com/item', 'https://example.com/item'], ['来源', 'javascript:alert(1)', undefined],
    ])
    const numbers = buildResultView(envelope({ rows: [0, null] }), {}, { type: 'list', items: 'rows', fields: [{ path: '$', label: '分数', prominent: true }] })
    expect(values(numbers.nodes).map(node => [node.label, node.text, node.prominent])).toEqual([['分数', '0', true], ['分数', '无值', false]])
  })

  it('previews five rows by default, expands in declared steps and bounds large collections', () => {
    const data = { rows: Array.from({ length: 100 }, (_, index) => index) }
    const presentation: ResultPresentation = { type: 'list', items: 'rows' }
    expect(collection(buildResultView(envelope(data), {}, presentation).nodes)).toMatchObject({ shown: 5, step: 5, total: 100, canExpand: true, canCollapse: false })
    expect(collection(buildResultView(envelope(data), {}, presentation, { visibleRows: { rows: 10 } }).nodes)).toMatchObject({ shown: 10, canExpand: true, canCollapse: true })
    expect(collection(buildResultView(envelope(data), {}, presentation, { visibleRows: { rows: 10000 } }).nodes)).toMatchObject({ shown: MAX_VISIBLE_ROWS, canExpand: false })
    expect(collection(buildResultView(envelope(data), {}, { ...presentation, max_rows: 3 }).nodes)).toMatchObject({ shown: 3, step: 3 })
  })

  it('applies an automatic presentation row limit to root and nested collections', () => {
    const rows = Array.from({ length: 12 }, (_, index) => index)
    const presentation: ResultPresentation = { type: 'auto', max_rows: 2 }
    expect(collection(buildResultView(envelope(rows), {}, presentation).nodes)).toMatchObject({ shown: 2, step: 2 })
    expect(collection(buildResultView(envelope({ result: { nested: { rows } } }), {}, presentation).nodes)).toMatchObject({ shown: 2, step: 2 })
    expect(collection(buildResultView(envelope({ nested: { rows } }), {}, { type: 'stats', fields: [{ path: 'nested' }], max_rows: 3 }).nodes)).toMatchObject({ shown: 3, step: 3 })
  })

  it('distinguishes an empty returned collection from a partial query with no returned items', () => {
    expect(collection(buildResultView(envelope({ rows: [] })).nodes).emptyText).toBe('本次返回 0 项')
    expect(collection(buildResultView(envelope({ rows: [] }, { outcome: 'partial' })).nodes).emptyText).toBe('本次未返回条目')
    const missing = buildResultView(envelope({}), {}, { type: 'list', items: 'rows' })
    expect(values(missing.nodes)[0]).toMatchObject({ status: 'missing', text: '未提供' })
  })

  it('renders standard feed values without turning null or masked metrics into zero', () => {
    const data = { items: [{ author: { name: null }, title: null, text: '正文', published_at: null, url: 'https://example.com/post', metrics: { likes: 0, comments: null, shares: 5, views: 100 } }] }
    const view = buildResultView(envelope(data, { outcome: 'partial', fields: { 'items[0].metrics.shares': { status: 'unknown' }, 'items.0.metrics.views': { status: 'unavailable' } } }), {}, { type: 'feed', items: 'items' })
    const item = collection(view.nodes).rows[0]
    expect(item?.kind).toBe('feed')
    if (item?.kind !== 'feed') throw new Error('expected feed')
    expect(item.author.status).toBe('null')
    expect(item.metrics.map(node => [node.text, node.status])).toEqual([['0', 'ok'], ['无值', 'null'], ['未知', 'unknown'], ['暂不可用', 'unavailable']])
    expect(item.link.href).toBe('https://example.com/post')
    const html = renderToStaticMarkup(createElement(ResultData, { envelope: envelope(data), presentation: { type: 'feed', items: 'items' } }))
    expect(html).toContain('作者未知')
    expect(html).toContain('发布时间未知')
    expect(html).toContain('1 项指标未知')
  })

  it('omits the redundant count unit only in a labeled feed metric', () => {
    const data = { items: [{ metrics: { likes: 4 } }], count: 2 }
    const schema = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { metrics: { type: 'object', properties: { likes: { type: 'number', 'x-unit': 'count' } } } } } }, count: { type: 'number', 'x-unit': 'count' } } }
    const feed = renderToStaticMarkup(createElement(ResultData, { envelope: envelope(data), schema, presentation: { type: 'feed', items: 'items' } }))
    expect(feed).toContain('赞：')
    expect(feed).not.toContain('result-data-unit')
    const auto = renderToStaticMarkup(createElement(ResultData, { envelope: envelope(data), schema }))
    expect(auto).toContain('result-data-unit">count')
  })

  it('only formats numeric timestamps when their unit is explicitly declared', () => {
    const seconds = 1_800_000_000
    const schema = { type: 'object', properties: { when: { type: 'number', 'x-unit': 'unix_seconds' }, raw: { type: 'number' }, iso: { type: 'string', format: 'date-time' } } }
    const fields = values(buildResultView(envelope({ when: seconds, raw: seconds, iso: '2026-11-03T08:00:00Z' }), schema).nodes)
    expect(fields[0]?.text).toBe(new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false }))
    expect(fields[0]?.unit).toBe('')
    expect(fields[1]?.text).toBe(String(seconds))
    expect(fields[2]?.text).toBe(new Date('2026-11-03T08:00:00Z').toLocaleString('zh-CN', { hour12: false }))
  })

  it('bounds deep structures, text, columns and total nodes, including expanded feeds', () => {
    let deep: unknown = 'deep secret'
    for (let index = 0; index < 30; index++) deep = { nested: deep }
    const deepView = buildResultView(envelope({ deep, text: 'x'.repeat(10000), many: Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`field${index}`, index])) }))
    expect(JSON.stringify(deepView)).not.toContain('deep secret')
    expect(descendants(deepView.nodes).some(node => node.kind === 'limit')).toBe(true)
    expect(values(deepView.nodes).find(node => node.path === 'text')).toMatchObject({ text: 'x'.repeat(4000), truncated: true })
    const table = collection(buildResultView(envelope({ rows: [Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`column${index}`, index]))] })).nodes)
    expect(table.columns).toHaveLength(6)
    const feed = buildResultView(envelope({ items: Array.from({ length: 100 }, () => ({ text: '正文', metrics: {} })) }), {}, { type: 'feed', items: 'items' }, { visibleRows: { items: 10000 } })
    expect(descendants(feed.nodes).length).toBeLessThanOrEqual(400)
    expect(collection(feed.nodes).canExpand).toBe(false)
  })

  it('never substitutes schema defaults or examples and suppresses failed or JSON-only payloads', () => {
    const schema = { type: 'object', properties: { absent: { type: 'string', default: 'default secret', example: 'example secret' } } }
    expect(values(buildResultView(envelope({}), schema).nodes)[0]).toMatchObject({ status: 'missing', text: '未提供' })
    expect(JSON.stringify(buildResultView(envelope({}), schema))).not.toContain('secret')
    expect(buildResultView(envelope({ secret: 'payload' }, { outcome: 'error' })).nodes).toEqual([])
    expect(buildResultView(envelope({ secret: 'payload' }), {}, { type: 'json' }).nodes).toEqual([])
  })

  it('accepts only bounded static paths and rejects prototype traversal or expressions', () => {
    expect(presentationPath('$')).toEqual([])
    expect(presentationPath('$.result.rows')).toEqual(['result', 'rows'])
    expect(presentationPath('result.user_name')).toEqual(['result', 'user_name'])
    for (const path of ['', '$..rows', 'rows[0]', 'rows.*', 'rows[?(@.secret)]', '__proto__.x', 'rows.constructor.name', 'prototype', 'a.'.repeat(8) + 'a', 'a'.repeat(129)]) expect(presentationPath(path)).toBeUndefined()
    expect(presentationPath(Array(8).fill('a').join('.'))).toHaveLength(8)
  })

  it('escapes markup, avoids external image requests and never nests a button inside a link', () => {
    const raw = '<img src="https://tracking.example/x" onerror="alert(1)">'
    const longLink = `https://example.com/${'a'.repeat(500)}`
    const data = { text: raw, image_url: 'https://example.com/avatar.png', site: longLink, bad: 'javascript:alert(1)' }
    const schema = { type: 'object', properties: { site: { format: 'uri' }, bad: { format: 'uri' } } }
    const html = renderToStaticMarkup(createElement(ResultData, { envelope: envelope(data), schema }))
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toMatch(/<a[^>]*>[\s\S]*?<button/)
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('referrerPolicy="no-referrer"')
    for (const url of ['javascript:alert(1)', 'data:text/html,hello', '//example.com', 'https://name:password@example.com', 'https://[REDACTED]@example.com']) expect(safeResultLink(url)).toBeUndefined()
    expect(safeResultLink('http://example.com/path')).toBe('http://example.com/path')
  })
})
