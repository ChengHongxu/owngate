import { describe, expect, it } from 'vitest'
import { resultFields } from '../src/lib/query-result'

const source = { connection_id: 'fixture', connection_label: '示例连接', capability_id: 'account.balance' }

describe('query result summaries', () => {
  it('keeps actual zero, false, empty text and null distinct from missing and hidden data', () => {
    const fields = resultFields({ outcome: 'partial', source,
      data: { quota: 0, available: false, username: '', email: null, missing: null, hidden: null },
      fields: { quota: { status: 'ok', unit: 'quota' }, missing: { status: 'unknown' }, hidden: { status: 'redacted' } },
    })
    expect(fields.map(field => [field.key, field.value, field.unit])).toEqual([
      ['quota', '0', 'quota'], ['available', '否', ''], ['username', '空文本', ''],
      ['email', '无值', ''], ['missing', '未知', ''], ['hidden', '已隐藏', ''],
    ])
  })

  it('uses the actual declared unit without assuming that quota or balances mean dollars', () => {
    for (const unit of ['', 'quota', 'CNY', 'USD', 'site_balance']) {
      const field = resultFields({ outcome: 'success', source, data: { quota: 0.0000000000000000000001 }, fields: { quota: { status: 'ok', unit } } })[0]!
      expect(field.value).toBe('1e-22')
      expect(field.unit).toBe(unit === 'site_balance' ? '单位待确认' : unit)
    }
    expect(resultFields({ outcome: 'success', source, data: { quota: 12 }, fields: {} })[0]?.unit).toBe('')
  })

  it('preserves failed and expired field states while showing only the authorized value', () => {
    const fields = resultFields({ outcome: 'partial', source, data: { quota: null, used_quota: 3, email: null }, fields: {
      quota: { status: 'unavailable', unit: 'USD' }, used_quota: { status: 'expired', unit: 'quota' }, email: { status: 'redacted' },
    } })
    expect(fields.map(field => [field.value, field.status])).toEqual([['暂不可用', 'unavailable'], ['3', 'expired'], ['已隐藏', 'redacted']])
    expect(resultFields({ outcome: 'error', source, data: { quota: 100 }, fields: {} })).toEqual([])
  })

  it('counts returned collections without interpreting nested unknowns as zero', () => {
    const fields = resultFields({ outcome: 'partial', source: { ...source, capability_id: 'feed.list' }, data: { items: [{ title: '内容' }], has_more: null }, fields: { 'items[0].metrics.likes': { status: 'unknown' }, has_more: { status: 'unknown' } } })
    expect(fields.map(field => [field.key, field.value])).toEqual([['items', '1 项'], ['has_more', '未知']])
    expect(resultFields({ outcome: 'success', source, data: [], fields: {} })[0]?.value).toBe('0 项')
  })
})
