import { ApiError, describeAuthError } from '../lib/http'

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null
  const message = describeAuthError(error)
  const readable = /[\u3400-\u9fff]/.test(message)
  return <div className="inline-notice" role="alert">
    <p className="error-text">{readable ? message : '请求未完成，请重试。'}</p>
    {!readable && <details className="field-help"><summary>技术详情</summary><p className="mono small">{message}</p></details>}
  </div>
}

export function QueryFailure({ error, title, retry, pending = false }: { error: unknown; title: string; retry: () => void; pending?: boolean }) {
  return <div className="query-state" role="alert">
    <p className="card-title">{title}</p>
    <button onClick={retry} disabled={pending}>{pending ? '重试中…' : '重试'}</button>
    <details className="field-help"><summary>技术详情</summary>
      <p className="mono small">{error instanceof ApiError ? `HTTP ${error.status} · ` : ''}{describeAuthError(error)}</p>
    </details>
  </div>
}
