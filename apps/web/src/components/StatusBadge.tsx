// 状态一律同时用文字、颜色、图标表达（需求 §8：不只靠颜色区分）
import { Icon, type IconName } from './Icon'

export const STATUS_STYLES: Record<string, { label: string; icon: IconName; className: string }> = {
  supported: { label: '可用', icon: 'check', className: 'status status-ok' },
  partial: { label: '部分可用', icon: 'partial', className: 'status status-warn' },
  needs_auth: { label: '需要认证', icon: 'key', className: 'status status-warn' },
  needs_plan: { label: '需要更高档位', icon: 'warning', className: 'status status-warn' },
  needs_adapter: { label: '适配异常', icon: 'warning', className: 'status status-warn' },
  unavailable: { label: '暂不可用', icon: 'warning', className: 'status status-warn' },
  unsupported: { label: '不支持', icon: 'blocked', className: 'status status-muted' },
  disabled: { label: '已关闭', icon: 'minus', className: 'status status-muted' },
  healthy: { label: '正常', icon: 'check', className: 'status status-ok' },
  unverified: { label: '待验证', icon: 'question', className: 'status status-muted' },
  degraded: { label: '降级', icon: 'partial', className: 'status status-warn' },
  paused: { label: '已暂停', icon: 'pause', className: 'status status-muted' },
  broken: { label: '故障', icon: 'close', className: 'status status-error' },
  ok: { label: '成功', icon: 'check', className: 'status status-ok' },
  error: { label: '失败', icon: 'close', className: 'status status-error' },
  pending: { label: '待处理', icon: 'clock', className: 'status status-warn' },
  running: { label: '执行中', icon: 'clock', className: 'status status-warn' },
  success: { label: '成功', icon: 'check', className: 'status status-ok' },
  failed: { label: '失败', icon: 'close', className: 'status status-error' },
  cancelled: { label: '已取消本地任务', icon: 'minus', className: 'status status-muted' },
  unknown_outcome: { label: '远端结果不明', icon: 'question', className: 'status status-warn' },
  approved: { label: '已批准，写执行仍关闭', icon: 'check', className: 'status status-muted' },
  rejected: { label: '已拒绝', icon: 'close', className: 'status status-muted' },
  expired: { label: '已过期', icon: 'clock', className: 'status status-muted' },
  stale: { label: '内容已变更', icon: 'warning', className: 'status status-warn' },
}

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? {
    label: status,
    icon: 'question' as const,
    className: 'status status-muted',
  }
  return (
    <span className={s.className}>
      <Icon name={s.icon} size={14} />{s.label}
    </span>
  )
}
