import type { Envelope } from '../lib/api'
import { useResultCapability, type ResultCapability } from '../lib/use-result-capability'
import { StatusBadge } from './StatusBadge'
import { ExecutionTrace } from './ExecutionTrace'
import { QueryRequestError } from '../lib/execution'
import { describeAuthError } from '../lib/http'
import { ResultData } from './ResultData'

function timeText(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

export function QueryResult({ envelope, title, capability, showData = true }: { envelope: Envelope; title?: string; capability?: ResultCapability; showData?: boolean }) {
  const definition = useResultCapability(envelope, capability, showData)
  const nextStep = envelope.error?.details?.['next_step']
  const hasData = envelope.outcome !== 'error' && envelope.data !== undefined && envelope.data !== null
  return <div className="query-result result-summary" role="group" aria-label="查询结果">
    <div className="card-row"><strong>{title ?? envelope.source.connection_label}</strong><StatusBadge status={envelope.outcome === 'success' ? 'ok' : envelope.outcome} /></div>
    {envelope.error && <div className="query-error" role="alert"><p className="error-text">{envelope.error.message || '查询未完成，请查看执行过程。'}</p><code className="query-error-code">{envelope.error.code}</code>{typeof nextStep === 'string' && nextStep.trim() && <p className="muted small">下一步：{nextStep}</p>}</div>}
    {envelope.outcome === 'error' && !envelope.error && <p className="error-text" role="alert">查询失败，服务未返回具体原因。</p>}
    {showData && <ResultData key={`data:${envelope.execution?.id ?? envelope.queried_at}`} envelope={envelope}
      {...(definition ? { schema: definition.output } : {})}
      {...(definition?.presentation ? { presentation: definition.presentation } : {})} />}
    {envelope.warnings.length === 1 ? <p className="muted small">{envelope.warnings[0]}</p> : envelope.warnings.length > 1 ? <details className="result-warnings"><summary>{envelope.warnings.length} 条提示</summary>{envelope.warnings.map((warning, index) => <p className="muted small" key={index}>{warning}</p>)}</details> : null}
    <p className="muted small">{title ? `${envelope.source.connection_label} · ` : ''}{hasData ? '数据于' : '查询于'} {timeText(hasData ? envelope.data_time : envelope.queried_at)} · {envelope.cache?.hit ? '缓存' : '本次查询'}</p>
    <ExecutionTrace key={`trace:${envelope.execution?.id ?? envelope.queried_at}`} {...(envelope.execution ? { trace: envelope.execution } : {})} failed={envelope.outcome === 'error'} />
    <details className="result-details field-help" open={definition?.presentation?.type === 'json'}><summary>详细数据</summary>
      <p className="muted small">{envelope.source.capability_id} · 数据时间 {envelope.data_time} · 查询时间 {envelope.queried_at}</p>
      {envelope.error && <p className="mono small">{envelope.error.code}</p>}
      {hasData ? <pre className="envelope">{JSON.stringify(envelope.data, null, 2)}</pre> : <p className="muted small">此次查询未产生数据。</p>}
      {Object.keys(envelope.fields).length > 0 && <pre className="envelope">{JSON.stringify(envelope.fields, null, 2)}</pre>}
    </details>
  </div>
}

export function QueryRequestFailure({ error }: { error: unknown }) {
  const requestError = error instanceof QueryRequestError ? error : undefined
  return <div className="query-request-failure">
    <div className="query-error" role="alert"><p className="error-text">调用失败：{describeAuthError(error)}</p>
      {requestError?.code && <code className="query-error-code">{requestError.code}</code>}
      {requestError?.nextStep && <p className="muted small">下一步：{requestError.nextStep}</p>}
    </div>
    <ExecutionTrace {...(requestError ? { trace: requestError.execution } : {})} failed />
  </div>
}
