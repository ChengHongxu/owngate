import type { Envelope } from './api'

export interface ResultField {
  key: string
  label: string
  value: string
  unit: string
  status: string
  reason?: string
  prominent: boolean
}

const labels: Record<string, string> = {
  quota: '账户余额', remaining: '剩余额度', balance: '余额', used_quota: '已用额度',
  request_count: '请求数', nickname: '昵称', username: '用户名', uid: '账户 ID', email: '邮箱',
  available: '服务可用', models: '模型', records: '本页记录', total: '总数',
  channels: '本页渠道', items: '本次内容', rpm: '每分钟请求', tpm: '每分钟 token',
  has_more: '还有更多', hasMore: '还有更多', value: '结果',
}
const unitLabels: Record<string, string> = {
  site_balance: '单位待确认', requests: '次请求', records: '条', channels: '个渠道',
  requests_per_minute: '次/分钟', tokens_per_minute: 'tokens/分钟', ratio: '倍',
}
const hiddenSummaryKeys = new Set(['face_url', 'avatar_url', 'next_cursor', 'nextCursor'])
const balanceKeys = new Set(['quota', 'remaining', 'balance', 'used_quota'])
const states: Record<string, string> = { unknown: '未知', unavailable: '暂不可用', redacted: '已隐藏' }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function labelFor(key: string, capability: string): string {
  if (key === 'quota' && ['usage.summary', 'admin.usage'].includes(capability)) return '时段用量'
  return Object.hasOwn(labels, key) ? labels[key]! : key
}

/** Values and units come from the authorized envelope; no currency or missing value is inferred. */
export function resultFields(envelope: Pick<Envelope, 'data' | 'fields' | 'source' | 'outcome'>): ResultField[] {
  if (envelope.outcome === 'error' || envelope.data === null || envelope.data === undefined) return []
  const data = record(envelope.data) ?? { value: envelope.data }
  const extra = Object.keys(envelope.fields).filter(key => !Object.hasOwn(data, key) && !/[.\[\]]/.test(key))
  return [...Object.keys(data), ...extra].flatMap(key => {
    if (hiddenSummaryKeys.has(key)) return []
    const value = data[key]
    const meta = record(envelope.fields[key])
    const status = typeof meta?.['status'] === 'string' ? meta['status'] : 'ok'
    const unit = typeof meta?.['unit'] === 'string' ? meta['unit'] : ''
    let text: string
    if (Object.hasOwn(states, status)) text = states[status]!
    else if (value === null || value === undefined) text = '无值'
    else if (Array.isArray(value)) text = `${value.length} 项`
    else if (typeof value === 'boolean') text = value ? '是' : '否'
    else if (typeof value === 'number') text = Number.isFinite(value) ? String(value) : '无效数值'
    else if (typeof value === 'string') text = value === '' ? '空文本' : value
    else return []
    return [{ key, label: labelFor(key, envelope.source.capability_id), value: text,
      unit: Object.hasOwn(unitLabels, unit) ? unitLabels[unit]! : unit,
      status, ...(typeof meta?.['reason'] === 'string' ? { reason: meta['reason'] } : {}),
      prominent: balanceKeys.has(key) && typeof value === 'number' && !Object.hasOwn(states, status),
    }]
  }).slice(0, 6)
}
