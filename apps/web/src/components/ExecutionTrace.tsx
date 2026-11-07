import type { ExecutionTrace as Trace } from '../lib/api'
import { durationText, failedExecutionStep } from '../lib/execution'
import { Icon } from './Icon'
import './ExecutionTrace.css'

const stepState = {
  success: { icon: 'check', label: '完成' }, partial: { icon: 'warning', label: '部分完成' },
  error: { icon: 'close', label: '失败' }, skipped: { icon: 'minus', label: '未执行' },
} as const

export function ExecutionTrace({ trace, failed = false }: { trace?: Trace; failed?: boolean }) {
  if (!trace && !failed) return null
  const failure = trace ? failedExecutionStep(trace) : undefined
  return <details className="execution-trace" open={failed}>
    <summary><span>执行过程</span><span className="muted small">{failure ? `停在「${failure.label}」` : trace ? durationText(trace.duration_ms) : '未记录'}</span></summary>
    {trace?.steps.length ? <>
      <ol className="execution-steps" aria-label="本次查询执行步骤">
        {trace.steps.map((step, index) => {
          const state = stepState[step.status]
          return <li key={`${step.id}:${index}`} className={`execution-step execution-step-${step.status}`}>
            <span className="execution-step-mark" aria-hidden="true"><Icon name={state.icon} size={12} /></span>
            <div className="execution-step-content"><span className="execution-step-label">{step.label}</span><span className="execution-step-status">{state.label}</span>
              {step.detail && <p className="execution-step-detail">{step.detail}</p>}
              {step.code && <code className="execution-step-code">{step.code}</code>}
            </div>
            <span className="execution-step-time muted small">{durationText(step.duration_ms)}</span>
          </li>
        })}
      </ol>
      <p className="execution-trace-meta muted small">总耗时 {durationText(trace.duration_ms)} · {new Date(trace.started_at).toLocaleString('zh-CN')}<span className="execution-trace-id"> · {trace.id}</span></p>
    </> : <p className="muted small">此结果没有执行记录，重新试查后可查看。</p>}
  </details>
}
