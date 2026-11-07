import { request } from './api'

export interface SmtpInput {
  label: string; host: string; port: number; secure: boolean; user: string; pass?: string; from: string; to: string[]
}
export interface SmtpChannel extends Omit<SmtpInput, 'pass'> {
  id: string; type: 'smtp'; has_password: boolean; created_at: string
}
export interface MonitorInput {
  label: string; connection_id: string; capability_id: string; cron: string; timezone: 'UTC'; condition: string;
  mode: 'data' | 'failure'; channel_id: string; cooldown_seconds: number; input: Record<string, unknown>; email_fields: string[]; enabled: boolean
}
export type MonitorDelivery = 'none' | 'sent' | 'failed' | 'suppressed'
export interface Monitor extends MonitorInput {
  id: string; created_at: string; next_run_at: string | null;
  runtime: { last_run_at: string | null; last_result: 'never' | 'running' | 'alert' | 'normal' | 'skipped' | 'error'; last_status: string | null;
    last_error: string | null; active: boolean; false_streak: number; last_notification_at: string | null; delivery: MonitorDelivery }
}
export interface MonitorRun {
  monitor: Monitor; result: { evaluation: 'alert' | 'normal' | 'skipped'; reason?: string; delivery: MonitorDelivery }
}
const id = encodeURIComponent
export const monitorsApi = {
  channels: () => request<{ channels: SmtpChannel[] }>('/admin/notification-channels'),
  createChannel: (input: SmtpInput) => request<SmtpChannel>('/admin/notification-channels', { method: 'POST', body: input }),
  updateChannel: (channelId: string, input: SmtpInput) => request<SmtpChannel>(`/admin/notification-channels/${id(channelId)}`, { method: 'PUT', body: input }),
  deleteChannel: (channelId: string) => request<{ ok: true }>(`/admin/notification-channels/${id(channelId)}`, { method: 'DELETE' }),
  testChannel: (channelId: string) => request<{ ok: true; status: 'sent' }>(`/admin/notification-channels/${id(channelId)}/test`, { method: 'POST' }),
  list: () => request<{ monitors: Monitor[] }>('/admin/monitors'),
  create: (input: MonitorInput) => request<Monitor>('/admin/monitors', { method: 'POST', body: input }),
  update: (monitorId: string, input: MonitorInput) => request<Monitor>(`/admin/monitors/${id(monitorId)}`, { method: 'PUT', body: input }),
  setEnabled: (monitorId: string, enabled: boolean) => request<Monitor>(`/admin/monitors/${id(monitorId)}`, { method: 'PATCH', body: { enabled } }),
  remove: (monitorId: string) => request<{ ok: true }>(`/admin/monitors/${id(monitorId)}`, { method: 'DELETE' }),
  run: (monitorId: string) => request<MonitorRun>(`/admin/monitors/${id(monitorId)}/run`, { method: 'POST' }),
}
const RESULT_LABEL = { never: '尚未执行', running: '正在查询', alert: '条件已触发', normal: '条件未触发', skipped: '无法判断', error: '执行失败' }
const DELIVERY_LABEL = { none: '本次未发邮件', sent: '邮件已交给 SMTP 服务', failed: '邮件发送失败', suppressed: '冷却期内已去重' }
export function monitorResultText(monitor: Monitor): string {
  const result = RESULT_LABEL[monitor.runtime.last_result]
  const detail = monitor.runtime.last_error === 'SMTP_DELIVERY_FAILED' ? '请检查 SMTP 配置，后续周期将重试' : monitor.runtime.last_error === 'RUN_INTERRUPTED' ? '上次执行被服务重启中断' : monitor.runtime.last_error === 'INVOKE_FAILED' ? '统一查询执行失败' : ''
  return [result, DELIVERY_LABEL[monitor.runtime.delivery], detail].filter(Boolean).join(' · ')
}
export function runResultText(result: MonitorRun['result']): string {
  const evaluation = result.evaluation === 'alert' ? '条件已触发' : result.evaluation === 'normal' ? '条件未触发' : result.reason === 'QUERY_FAILED' ? '站点查询失败，数据条件未求值；请配置独立的查询失败规则' : '字段不存在、已隐藏或不可用，条件未求值'
  return `${evaluation}；${DELIVERY_LABEL[result.delivery]}`
}
