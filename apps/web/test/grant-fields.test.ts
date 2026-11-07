import { describe, expect, it } from 'vitest'
import { analyzeGrantFields, grantFieldGroups, normalizeVisibility } from '../src/lib/grant-fields'

function cap(output: Record<string, unknown>, id = 'fixture.read', title = '示例查询') { return { id, title, output } }
function object(properties: Record<string, unknown>) { return { type: 'object', additionalProperties: false, properties } }

describe('grant field descriptions', () => {
  it('only includes classifications present in the selected capability schemas', () => {
    const result = analyzeGrantFields([
      cap(object({ nickname: { type: 'string', 'x-sensitivity': 'pii' }, face_url: { type: 'string' } }), 'account.profile'),
      cap(object({ items: { type: 'array', items: object({ title: { type: 'string' }, author: object({ name: { type: 'string', 'x-sensitivity': 'pii' } }) }) } }), 'feed.list'),
    ])
    expect(result.complete).toBe(true)
    expect(result.groups.map(group => group.key)).toEqual(['pii', 'content'])
    expect(result.groups[0]).toMatchObject({ label: '个人信息', fields: ['昵称', '条目 · 作者 · 名称'], count: 2 })
    expect(result.groups.find(group => group.key === 'financial')).toBeUndefined()
  })

  it('uses declared field titles and preserves each selected capability as a distinct declaration', () => {
    const output = object({ amount: { type: 'number', title: '本期费用', 'x-sensitivity': 'financial' } })
    expect(grantFieldGroups([cap(output, 'period.one'), cap(output, 'period.two')])).toEqual([
      { key: 'financial', label: '财务数据', fields: ['本期费用'], count: 2 },
    ])
  })

  it('retains parent gates while unannotated and differently annotated children add their actual gates', () => {
    const result = analyzeGrantFields([cap(object({
      ledger: { ...object({
        amount: { type: 'number', title: '金额' },
        owner: { type: 'string', title: '经办人', 'x-sensitivity': 'pii' },
      }), title: '账本', 'x-sensitivity': 'financial' },
    }))])
    expect(result.groups).toEqual([
      { key: 'pii', label: '个人信息', fields: ['账本 · 经办人'], count: 1 },
      { key: 'financial', label: '财务数据', fields: ['账本 · 金额', '账本 · 经办人'], count: 2 },
      { key: 'content', label: '网站内容', fields: ['账本 · 金额'], count: 1 },
    ])
  })

  it('treats array containers and item schemas as separate gates without multiplying rows', () => {
    const result = grantFieldGroups([cap(object({
      names: { type: 'array', title: '参与人', 'x-sensitivity': 'pii', items: { type: 'string' } },
      fees: { type: ['array', 'null'], title: '费用', items: { type: 'number', 'x-sensitivity': 'financial' } },
    }))])
    expect(result).toEqual([
      { key: 'pii', label: '个人信息', fields: ['参与人'], count: 1 },
      { key: 'financial', label: '财务数据', fields: ['费用'], count: 1 },
      { key: 'content', label: '网站内容', fields: ['参与人', '费用'], count: 2 },
    ])
  })

  it('uses array item titles and falls back to capability plus path for undocumented field names', () => {
    const result = grantFieldGroups([cap(object({
      models: { type: 'array', items: { type: 'string', title: '模型名称' } },
      source_code: { type: 'string' },
    }))])
    expect(result[0]?.fields).toEqual(['模型名称', '示例查询 · source_code'])
  })

  it('excludes secrets, forbidden keys and their complete subtrees regardless of child classifications', () => {
    const properties = {
      token: { type: 'string', title: '不会显示', 'x-sensitivity': 'pii' },
      account_secret: object({ nested: { type: 'number', 'x-sensitivity': 'financial' } }),
      password: { type: 'string' },
      hidden: { ...object({ title: { type: 'string', 'x-sensitivity': 'content' } }), 'x-secret': true },
      write_only: { ...object({ name: { type: 'string', 'x-sensitivity': 'pii' } }), writeOnly: true },
      classified: { ...object({ value: { type: 'number' } }), 'x-sensitivity': 'secret' },
      unknown: { type: 'string', 'x-sensitivity': 'future-classification' },
      public: { type: 'boolean', title: '可用' },
    }
    Object.defineProperty(properties, '__proto__', { value: { type: 'string' }, enumerable: true })
    expect(grantFieldGroups([cap(object(properties))])).toEqual([{ key: 'content', label: '网站内容', fields: ['可用'], count: 1 }])
  })

  it('matches the vault root boundary rather than inventing a root classification gate', () => {
    const result = analyzeGrantFields([cap({ ...object({
      email: { type: 'string', 'x-sensitivity': 'pii' }, title: { type: 'string' },
    }), 'x-sensitivity': 'financial' })])
    expect(result.groups.map(group => group.key)).toEqual(['pii', 'content'])
    expect(grantFieldGroups([cap({ type: 'string', 'x-sensitivity': 'pii' })])).toEqual([])
  })

  it('does not mistake absent metadata or dynamic schemas for a complete concrete field list', () => {
    expect(analyzeGrantFields([])).toEqual({ groups: [], complete: true })
    expect(analyzeGrantFields([cap({})])).toEqual({ groups: [], complete: false })
    expect(analyzeGrantFields([cap(object({}))])).toEqual({ groups: [], complete: true })
    const result = analyzeGrantFields([cap({
      ...object({ email: { type: 'string', 'x-sensitivity': 'pii' } }),
      additionalProperties: { type: 'number', 'x-sensitivity': 'financial' },
    })])
    expect(result.complete).toBe(false)
    expect(result.groups.map(group => group.key)).toEqual(['pii'])
    expect(analyzeGrantFields([cap({ type: 'array' })]).complete).toBe(false)
    expect(analyzeGrantFields([cap({ $ref: '#/definitions/unknown' })]).complete).toBe(false)
    expect(analyzeGrantFields([cap({ oneOf: [{ type: 'string' }] })]).complete).toBe(false)
  })

  it('limits example labels and analysis work while marking incomplete rather than claiming an exact large count', () => {
    const properties = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`value_${index}`, { type: 'number', title: `字段 ${index}` }]))
    const result = analyzeGrantFields([cap(object(properties))])
    expect(result.complete).toBe(false)
    expect(result.groups[0]?.fields).toEqual(['字段 0', '字段 1', '字段 2'])
    expect(result.groups[0]?.count).toBeLessThanOrEqual(1000)
    let deep: Record<string, unknown> = { type: 'string', title: '不应过度递归' }
    for (let index = 0; index < 30; index++) deep = object({ next: deep })
    expect(analyzeGrantFields([cap(deep)]).complete).toBe(false)
    const cycle: Record<string, unknown> = object({})
    cycle.properties = { next: cycle }
    expect(analyzeGrantFields([cap(cycle)]).complete).toBe(false)
  })

  it('keeps literal JSON property paths distinct and ignores schema defaults, examples and live data', () => {
    const result = grantFieldGroups([cap(object({
      'a.b': { type: 'string', title: '含点字段', default: 'secret default', example: 'secret example' },
      a: object({ b: { type: 'string', title: '嵌套字段' } }),
    }))])
    expect(result[0]?.count).toBe(2)
    expect(JSON.stringify(result)).not.toContain('secret')
  })
})

describe('grant visibility defaults', () => {
  it('requires an explicit grant to return personal information for every client', () => {
    expect(normalizeVisibility()).toEqual({ pii: false, financial: true, content: true })
    expect(normalizeVisibility({})).toEqual({ pii: false, financial: true, content: true })
  })

  it('preserves explicit false and saved overrides for each category', () => {
    expect(normalizeVisibility({ pii: false, financial: false, content: false })).toEqual({ pii: false, financial: false, content: false })
    const saved = { pii: true, financial: false }
    const policy = normalizeVisibility(saved)
    expect(policy).toEqual({ pii: true, financial: false, content: true })
    policy.pii = false
    expect(saved).toEqual({ pii: true, financial: false })
  })
})
