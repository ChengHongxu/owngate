import type { ExecutionStep, ExecutionTrace } from './api'
import { ApiError, describeAuthError } from './http'

export function durationText(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '耗时未知'
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`
}

export function failedExecutionStep(trace: ExecutionTrace): ExecutionStep | undefined {
  // The final result can repeat an earlier failure. Keep the last observed
  // failing execution stage, rather than replacing it with that summary.
  return trace.steps.filter(step => step.status === 'error' && step.id !== 'request.result').at(-1)
    ?? trace.steps.find(step => step.status === 'error')
}

/** Only records the browser-side boundary that actually failed. A failed
 * fetch cannot tell us which server stages, if any, were executed. */
export class QueryRequestError extends Error {
  readonly execution: ExecutionTrace
  readonly code?: string
  readonly nextStep?: string

  constructor(cause: unknown, stage: 'input' | 'request', startedAt = Date.now()) {
    super(describeAuthError(cause))
    this.name = 'QueryRequestError'
    if (cause instanceof ApiError && cause.code) this.code = cause.code
    if (cause instanceof ApiError && cause.nextStep) this.nextStep = cause.nextStep
    const duration = Math.max(0, Date.now() - startedAt)
    this.execution = {
      id: `local-${startedAt.toString(36)}`, started_at: new Date(startedAt).toISOString(), duration_ms: duration,
      steps: [{ id: `client.${stage}`, label: stage === 'input' ? '检查输入' : '提交查询', status: 'error', duration_ms: duration,
        detail: this.message, ...(this.code ? { code: this.code } : {}) }],
    }
  }
}
