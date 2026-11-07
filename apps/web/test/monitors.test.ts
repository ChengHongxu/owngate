import { describe, expect, it } from 'vitest'
import { monitorResultText, runResultText, type Monitor } from '../src/lib/monitors-api'

const monitor: Monitor = { id: 'fixture', label: 'Rule', connection_id: 'connection', capability_id: 'balance', cron: '* * * * *', timezone: 'UTC',
  condition: 'remaining < 5', mode: 'data', channel_id: 'smtp', cooldown_seconds: 3600, input: {}, email_fields: [], enabled: true,
  created_at: '', next_run_at: null, runtime: { last_run_at: null, last_result: 'never', last_status: null, last_error: null, active: false,
    false_streak: 0, last_notification_at: null, delivery: 'none' } }
describe('monitor operation feedback', () => {
  it('distinguishes alert evaluation from mail delivery and cooldown suppression', () => {
    expect(runResultText({ evaluation: 'alert', delivery: 'failed' })).toContain('邮件发送失败')
    expect(runResultText({ evaluation: 'alert', delivery: 'suppressed' })).toContain('冷却期内已去重')
    expect(runResultText({ evaluation: 'normal', delivery: 'none' })).toContain('条件未触发')
  })
  it('describes a failed query without pretending that the data rule evaluated normally', () => {
    const result = runResultText({ evaluation: 'skipped', reason: 'QUERY_FAILED', delivery: 'none' })
    expect(result).toContain('数据条件未求值')
    expect(result).toContain('独立的查询失败规则')
    expect(runResultText({ evaluation: 'skipped', reason: 'FIELD_NOT_EVALUABLE', delivery: 'none' })).toContain('字段不存在、已隐藏或不可用')
  })
  it('keeps never-run, interrupted, in-flight and SMTP-failed states visible', () => {
    expect(monitorResultText(monitor)).toContain('尚未执行')
    expect(monitorResultText({ ...monitor, runtime: { ...monitor.runtime, last_result: 'running' } })).toContain('正在查询')
    expect(monitorResultText({ ...monitor, runtime: { ...monitor.runtime, last_result: 'error', last_error: 'RUN_INTERRUPTED' } })).toContain('服务重启中断')
    expect(monitorResultText({ ...monitor, runtime: { ...monitor.runtime, last_result: 'alert', delivery: 'failed', last_error: 'SMTP_DELIVERY_FAILED' } })).toContain('后续周期将重试')
  })
})
