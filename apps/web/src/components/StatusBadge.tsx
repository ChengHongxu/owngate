// 状态一律同时用文字、颜色、图标表达（需求 §8：不只靠颜色区分）

export const STATUS_STYLES: Record<string, { label: string; icon: string; className: string }> = {
  supported: { label: '可用', icon: '✓', className: 'status status-ok' },
  partial: { label: '部分可用', icon: '◐', className: 'status status-warn' },
  needs_auth: { label: '需要重新登录', icon: '!', className: 'status status-warn' },
  needs_plan: { label: '需要更高档位', icon: '!', className: 'status status-warn' },
  needs_adapter: { label: '尚未适配', icon: '–', className: 'status status-muted' },
  unsupported: { label: '不支持', icon: '×', className: 'status status-muted' },
  disabled: { label: '已关闭', icon: '·', className: 'status status-muted' },
  healthy: { label: '正常', icon: '✓', className: 'status status-ok' },
  degraded: { label: '降级', icon: '◐', className: 'status status-warn' },
  paused: { label: '已暂停', icon: '❚❚', className: 'status status-muted' },
  broken: { label: '故障', icon: '×', className: 'status status-error' },
  ok: { label: '成功', icon: '✓', className: 'status status-ok' },
  error: { label: '失败', icon: '×', className: 'status status-error' },
}

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? {
    label: status,
    icon: '?',
    className: 'status status-muted',
  }
  return (
    <span className={s.className}>
      <span aria-hidden="true">{s.icon}</span> {s.label}
    </span>
  )
}
