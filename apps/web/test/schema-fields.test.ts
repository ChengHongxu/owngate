import { describe, expect, it } from 'vitest'
import { configFields, initialFields, inputFields, parseFields } from '../src/lib/schema-fields'

describe('connector form values', () => {
  it('sends typed numeric and boolean values and keeps explicit zero and false', () => {
    const fields = configFields({
      quota_per_unit: { type: 'number', minimum: 0.000001, required: true },
      attempts: { type: 'integer', default: 4 },
      enabled: { type: 'boolean', default: true },
    })
    const values = initialFields(fields, { attempts: 0, enabled: false })
    expect(values).toEqual({ quota_per_unit: '', attempts: '0', enabled: 'false' })
    expect(parseFields(fields, { ...values, quota_per_unit: '500000' })).toEqual({ quota_per_unit: 500000, attempts: 0, enabled: false })
  })

  it('uses declared defaults and leaves optional blank values unset', () => {
    const fields = configFields({
      base_url: { type: 'string', format: 'uri', default: 'https://www.bilibili.com' },
      quota_per_unit: { type: 'number' },
    })
    expect(parseFields(fields, {})).toEqual({ base_url: 'https://www.bilibili.com' })
    expect(parseFields(fields, { base_url: 'https://api.example.com', quota_per_unit: '' })).toEqual({ base_url: 'https://api.example.com' })
  })

  it('requires a complete HTTP URL and disallows credentials embedded in a site address', () => {
    const fields = configFields({ base_url: { type: 'string', format: 'uri', label: '站点地址', required: true } })
    expect(() => parseFields(fields, {})).toThrow('请填写站点地址')
    for (const base_url of ['api.example.com', 'file:///etc/passwd', 'https://user:password@example.com']) {
      expect(() => parseFields(fields, { base_url })).toThrow('站点地址')
    }
    expect(parseFields(fields, { base_url: '  https://api.example.com/v1  ' })).toEqual({ base_url: 'https://api.example.com/v1' })
  })

  it('rejects invalid numeric values and respects integer and bounds constraints', () => {
    const fields = configFields({ count: { type: 'integer', minimum: 1, maximum: 10 } })
    for (const count of ['NaN', 'Infinity', '1.5', '0', '11']) {
      expect(() => parseFields(fields, { count })).toThrow()
    }
    expect(parseFields(fields, { count: '10' })).toEqual({ count: 10 })
  })

  it('validates enums and string lengths before sending a request', () => {
    const fields = configFields({ mode: { type: 'string', enum: ['safe', 'fast'] }, name: { type: 'string', minLength: 2, maxLength: 4 } })
    expect(() => parseFields(fields, { mode: 'unknown' })).toThrow('请选择列表中的值')
    expect(() => parseFields(fields, { name: 'a' })).toThrow('至少需要')
    expect(() => parseFields(fields, { name: 'abcde' })).toThrow('最多允许')
    expect(parseFields(fields, { mode: 'safe', name: 'abcd' })).toEqual({ mode: 'safe', name: 'abcd' })
  })

  it('uses capability root required metadata and parses structured inputs', () => {
    const fields = inputFields({
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string' }, filters: { type: 'object' }, ids: { type: 'array' }, include_archived: { type: 'boolean' } },
    })
    expect(() => parseFields(fields, {})).toThrow('请填写query')
    expect(parseFields(fields, { query: 'hello', filters: '{"state":"active"}', ids: '[1,2]', include_archived: 'false' })).toEqual({
      query: 'hello', filters: { state: 'active' }, ids: [1, 2], include_archived: false,
    })
    expect(() => parseFields(fields, { query: 'hello', filters: '[]' })).toThrow('对象')
    expect(() => parseFields(fields, { query: 'hello', ids: '{}' })).toThrow('数组')
    expect(() => parseFields(fields, { query: 'hello', filters: '{' })).toThrow('有效的 JSON')
  })

  it('preserves secret bytes and permits partial credential updates', () => {
    const fields = configFields({ access_token: { type: 'string', secret: true, required: true }, other: { type: 'string', secret: true, required: true } })
    expect(parseFields(fields, { access_token: ' token with space ' }, { partial: true })).toEqual({ access_token: ' token with space ' })
    expect(() => parseFields(fields, { access_token: 'token' })).toThrow('请填写other')
  })
})
