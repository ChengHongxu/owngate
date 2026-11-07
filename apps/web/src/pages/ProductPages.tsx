import { useState, type MouseEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Envelope } from '../lib/api'
import { productApi, type Proposal, type TaskView } from '../lib/product-api'
import { describeAuthError } from '../lib/http'
import { StatusBadge } from '../components/StatusBadge'
import { ErrorNotice as Failure, QueryFailure } from '../components/RequestFeedback'
import { QueryResult } from '../components/QueryResult'
import { HelpTip } from '../components/HelpTip'
import { PageDialog } from '../components/PageDialog'
import { Icon } from '../components/Icon'
import './spatial-primary.css'

function timeText(value: string | number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

function follow(event: MouseEvent<HTMLAnchorElement>, go: () => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  go()
}

function EnvelopeView({ envelope }: { envelope: Envelope }) {
  return <QueryResult envelope={envelope} />
}

export function OverviewPage({ onConnection, onNavigate }: { onConnection: (id: string) => void; onNavigate: (page: 'tasks' | 'connections' | 'proposals') => void }) {
  const query = useQuery({ queryKey: ['overview'], queryFn: productApi.overview, refetchInterval: 10_000 })
  const pause = useMutation({ mutationFn: productApi.pauseActions })
  const data = query.data
  const connections = data?.connections ?? []
  const healthy = connections.filter(connection => connection.health.status === 'healthy').length
  const attention = connections.filter(connection => !['healthy', 'disabled', 'paused'].includes(connection.health.status))
  const ordered = [...connections].sort((a, b) => Number(attention.some(item => item.id === b.id)) - Number(attention.some(item => item.id === a.id)))
  return <section className="overview">
    <div className="page-heading"><h1>概览</h1>{data && connections.length > 0 && <a className="button primary" href="/connections" onClick={event => follow(event, () => onNavigate('connections'))}><Icon name="connections" />管理连接</a>}</div>
    {query.isPending && <div className="query-state" role="status"><p className="muted">正在读取概览…</p><div className="metric-grid" aria-hidden="true">{[0, 1, 2, 3].map(key => <div className="metric skeleton" key={key} />)}</div></div>}
    {!data && query.isError && <QueryFailure error={query.error} title="概览加载失败" retry={() => { void query.refetch() }} pending={query.isFetching} />}
    {data && <>
      <div className="overview-meta"><p className="muted small">更新于 <time dateTime={new Date(query.dataUpdatedAt).toISOString()}>{timeText(query.dataUpdatedAt)}</time></p><span className="status status-muted">只读模式</span></div>
      {query.isError && <div className="inline-notice" role="alert"><p>刷新失败，显示上次数据。</p><button onClick={() => { void query.refetch() }} disabled={query.isFetching}>{query.isFetching ? '重试中…' : '重试'}</button><details className="field-help"><summary>技术详情</summary><p className="mono small">{describeAuthError(query.error)}</p></details></div>}
      {connections.length === 0 ? <div className="empty-state"><h2>还没有连接</h2><p className="muted">添加一个网站，开始查询。</p><a className="button primary" href="/connections" onClick={event => follow(event, () => onNavigate('connections'))}><Icon name="add" />添加连接</a></div> : <>
        <div className="metric-grid">
          {([['连接', connections.length, 'connections', 'connections'], ['可用', healthy, 'connections', 'check'], ['需关注', attention.length, 'connections', 'warning'], ['待审提案', data.pending_proposals, 'proposals', 'proposals']] as const).map(([label, value, destination, icon]) => <a className="metric metric-link" key={label} href={`/${destination}`} onClick={event => follow(event, () => onNavigate(destination))}><span className="metric-label"><Icon name={icon} />{label}</span><strong className="metric-value">{value}</strong></a>)}
        </div>
      </>}
      <div className="overview-panels">
        {connections.length > 0 && <div className="panel overview-connections"><div className="panel-heading"><h2>连接状态</h2><a className="section-link" href="/connections" onClick={event => follow(event, () => onNavigate('connections'))}>查看全部</a></div>
          <ul className="item-list">{ordered.slice(0, 6).map(connection => <li className="item-row" key={connection.id}><a className="row-main" href={`/connections/${encodeURIComponent(connection.id)}`} onClick={event => follow(event, () => onConnection(connection.id))}>{connection.label}</a><StatusBadge status={connection.health.status} /></li>)}</ul>
        </div>}
        <div className="panel"><div className="panel-heading"><h2>最近任务</h2><a className="section-link" href="/tasks" onClick={event => follow(event, () => onNavigate('tasks'))}>查看全部</a></div>
          {data.tasks.length === 0 ? <p className="muted empty-state">暂无任务</p> : <ul className="item-list">{data.tasks.map(task => <li className="item-row" key={task.id}><div className="row-main"><a href={`/tasks/${encodeURIComponent(task.id)}`}>{task.capability_id}</a><p className="row-meta muted small">{timeText(task.created_at)}</p></div><StatusBadge status={task.status} /></li>)}</ul>}
        </div>
        <div className="panel"><div className="panel-heading"><h2>最近监控</h2><a className="section-link" href="/monitors">查看全部</a></div>
          {data.alerts.length === 0 ? <p className="muted empty-state">暂无监控记录</p> : <ul className="item-list">{data.alerts.map((alert, index) => <li className="item-row" key={index}><div className="row-main"><p>{alert.action === 'monitor.checked' ? '监控已检查' : alert.action === 'monitor.delivery.failed' ? '通知发送失败' : '监控活动'}</p><details className="field-help"><summary>查看详情</summary><p className="mono small">{alert.action} · {alert.target}</p></details></div><time className="row-meta muted small" dateTime={alert.at}>{timeText(alert.at)}</time></li>)}</ul>}
        </div>
      </div>
    </>}
    <details className="overview-safety field-help"><summary>安全控制</summary><div className="card-actions"><span className="muted small">写执行已关闭</span><button className="danger" disabled={pause.isPending} onClick={() => pause.mutate()}>停止全部写操作</button></div>{pause.isSuccess && <p role="status">写操作保持停止。</p>}<Failure error={pause.error} /></details>
  </section>
}

export function TasksPage({ selectedId, onSelect }: { selectedId?: string | undefined; onSelect: (id: string | undefined) => void }) {
  const query = useQuery({ queryKey: ['tasks'], queryFn: productApi.tasks, refetchInterval: 2000, enabled: !selectedId })
  if (selectedId) return <TaskDetail key={selectedId} id={selectedId} onBack={() => onSelect(undefined)} />
  return <section className="product-tasks"><div className="page-heading"><div className="help-heading"><h1>任务</h1><HelpTip label="任务说明">离开页面后任务继续执行。取消运行中的查询只停止本地等待，远端可能继续处理。</HelpTip></div></div>
    {query.isError && <QueryFailure title="任务加载失败" error={query.error} retry={() => { void query.refetch() }} pending={query.isFetching} />}
    {query.isPending && <p>正在读取任务…</p>}
    {query.data?.tasks.length === 0 && <div className="card">还没有任务。在连接详情中使用「作为任务查询」。</div>}
    <ul className="activity-list task-list">{query.data?.tasks.map((t) => <li className="activity-row" key={t.id}><div className="activity-main"><strong>{t.capability_id}</strong><p className="muted small">{timeText(t.created_at)} · 第 {t.attempts} 次执行</p></div><StatusBadge status={t.status} /><a className="button" href={`/tasks/${encodeURIComponent(t.id)}`} onClick={event => follow(event, () => onSelect(t.id))}>查看结果与过程</a></li>)}</ul>
  </section>
}
function TaskDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient()
  const task = useQuery({ queryKey: ['task', id], queryFn: () => productApi.task(id), refetchInterval: (q) => ['pending', 'running'].includes(q.state.data?.status ?? '') ? 1000 : false })
  const events = useQuery({ queryKey: ['task-events', id, task.data?.status], queryFn: () => productApi.taskEvents(id) })
  const cancel = useMutation({ mutationFn: () => productApi.cancelTask(id), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['task', id] }); void qc.invalidateQueries({ queryKey: ['tasks'] }) } })
  const t: TaskView | undefined = task.data
  return <section><a className="section-link" href="/tasks" onClick={event => follow(event, onBack)}><Icon name="back" size={14} />返回任务</a><div className="page-heading"><h1>任务详情</h1></div>
    {task.isPending && <p className="muted" role="status">正在读取任务…</p>}{task.isError && <QueryFailure title="任务加载失败" error={task.error} retry={() => { void task.refetch() }} pending={task.isFetching} />}
    <Failure error={cancel.error ?? events.error} />{t && <div className="panel"><div className="card-row"><strong>{t.capability_id}</strong><StatusBadge status={t.status} /></div>
    {['pending', 'running'].includes(t.status) && <button className="danger" disabled={cancel.isPending} onClick={() => cancel.mutate()}>取消本地任务</button>}
    {t.cancellation && <p className="muted">{t.cancellation.may_continue_remote ? '已停止本地等待，远端可能仍在执行。' : '已取消，尚未发送远端请求。'}</p>}
    {t.result && <EnvelopeView envelope={t.result} />}
    <details><summary>执行过程</summary>{events.data?.events.map((e) => <p key={e.id} className="muted small">{e.at} · {e.event}</p>)}</details>
  </div>}</section>
}

export function ProposalsPage() {
  const qc = useQueryClient()
  const proposals = useQuery({ queryKey: ['proposals'], queryFn: productApi.proposals, refetchInterval: 5000 })
  const [review, setReview] = useState<Proposal | null>(null)
  const approve = useMutation({ mutationFn: productApi.approve, onSuccess: () => { setReview(null); void qc.invalidateQueries({ queryKey: ['proposals'] }) } })
  const reject = useMutation({ mutationFn: productApi.reject, onSuccess: () => { setReview(null); void qc.invalidateQueries({ queryKey: ['proposals'] }) } })
  const deciding = approve.isPending || reject.isPending
  return <section className="product-proposals"><div className="page-heading"><div className="help-heading"><h1>操作提案</h1><HelpTip label="审批说明">批准只对应预览的具体内容。内容或连接配置变更后需要重新批准；当前批准后仍不会执行站点写操作。</HelpTip></div><span className="status status-muted">写执行已关闭</span></div>
    <Failure error={proposals.error} />
    {proposals.data?.proposals.length === 0 && <div className="card">还没有操作提案。</div>}
    <ul className="activity-list proposal-list">{proposals.data?.proposals.map((p) => <li className="activity-row" key={p.id}><div className="activity-main"><strong>{p.target.label} · {p.capability_id}</strong><p className="muted small">影响：{p.effect} · 有效至 {p.expires_at}</p></div><StatusBadge status={p.status} /><button onClick={() => { approve.reset(); reject.reset(); setReview(p) }}>预览具体内容</button></li>)}</ul>
    {review && <PageDialog title="确认提案内容" size="wide" onClose={() => setReview(null)} dismissible={!deciding}>
      <div className="proposal-review"><p>目标：{review.target.label}（{review.target.connector_id}）</p><pre className="envelope">{JSON.stringify(review.input, null, 2)}</pre><p className="muted small">未注册 Passkey 时使用 TOTP 的保护较弱，建议在安全设置注册 Passkey。</p>
      <Failure error={approve.error ?? reject.error} />
      <div className="card-actions"><button className="primary" disabled={review.status !== 'pending' || deciding} onClick={() => approve.mutate(review)}>{approve.isPending ? '批准中…' : '验证身份并批准此内容'}</button><button className="danger" disabled={!['pending', 'approved'].includes(review.status) || deciding} onClick={() => reject.mutate(review.id)}>{reject.isPending ? '拒绝中…' : '拒绝提案'}</button><button disabled={deciding} onClick={() => setReview(null)}>关闭</button></div>
      </div>
    </PageDialog>}
  </section>
}

export function AuditPage() {
  const [client, setClient] = useState(''), [connection, setConnection] = useState(''), [before, setBefore] = useState('')
  const query = useQuery({ queryKey: ['audit', client, connection, before], queryFn: () => productApi.audit({ client, connection, before }) })
  return <section className="product-audit"><div className="page-heading"><h1>审计记录</h1></div><div className="panel filter-bar"><label>客户端 ID<input value={client} onChange={(e) => { setClient(e.target.value); setBefore('') }} /></label><label>连接 ID<input value={connection} onChange={(e) => { setConnection(e.target.value); setBefore('') }} /></label></div>
    {query.isPending && <p className="muted" role="status">正在读取记录…</p>}{query.isError && <QueryFailure title="记录加载失败" error={query.error} retry={() => { void query.refetch() }} pending={query.isFetching} />}
    {query.data?.entries.length === 0 && <p className="muted empty-state">{before ? '没有更早的记录' : '暂无审计记录'}</p>}
    <ul className="activity-list audit-list">{query.data?.entries.map((e) => <li className="activity-row audit-row" key={e.seq}><strong>{e.action}</strong><time className="muted small" dateTime={e.at}>{timeText(e.at)}</time><p className="muted small">{e.client_id ?? '后台 / 系统'} · {e.target}</p><details className="field-help"><summary>查看详情</summary><pre className="envelope">{typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail, null, 2)}</pre><p className="muted small">记录指纹：{e.entry_hash}</p></details></li>)}</ul>
    <div className="card-actions"><button disabled={!query.data?.entries.length} onClick={() => setBefore(String(query.data?.entries.at(-1)?.seq ?? ''))}>更早的记录</button>{before && <button onClick={() => setBefore('')}>回到最新</button>}</div>
  </section>
}
