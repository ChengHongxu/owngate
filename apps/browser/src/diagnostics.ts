import type { ExecutionStep } from '@owngate/core'

/** Per-call, bounded metadata only. Never give this recorder page text, URLs,
 * parameters, request/response bodies, cookie values or exception messages. */
export class BrowserDiagnostics {
  private entries: { step: ExecutionStep; started: number; finished: boolean }[] = []
  private sealed = false

  start(id: string, label: string): (status: ExecutionStep['status'], detail?: string, code?: string) => void {
    if (this.sealed || this.entries.length >= 32) return () => undefined
    const entry = { step: { id, label, status: 'skipped' as ExecutionStep['status'], duration_ms: 0 }, started: performance.now(), finished: false }
    this.entries.push(entry)
    return (status, detail, code) => {
      if (this.sealed || entry.finished) return
      entry.finished = true
      entry.step = { id, label, status, duration_ms: Math.max(0, Math.round(performance.now() - entry.started)),
        ...(detail ? { detail } : {}), ...(code ? { code } : {}) }
    }
  }

  interrupt(code: string): void {
    for (const entry of this.entries) {
      if (entry.finished) continue
      entry.finished = true
      entry.step = { ...entry.step, status: 'error', duration_ms: Math.max(0, Math.round(performance.now() - entry.started)),
        detail: code === 'UPSTREAM_TIMEOUT' ? '执行超过本次等待时限' : '浏览器执行中断', code }
    }
  }

  finish(): ExecutionStep[] {
    this.sealed = true
    return this.entries.map(({ step }) => ({ ...step }))
  }
}
