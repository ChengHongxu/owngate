import { useQuery, useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type Envelope } from '../lib/api'
import { StatusBadge } from '../components/StatusBadge'

export function ConnectionDetailPage({
  id,
  onBack,
  onOpenScreen,
}: {
  id: string
  onBack: () => void
  onOpenScreen: (id: string) => void
}) {
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.listConnections })
  const conn = connections.data?.connections.find((c) => c.id === id)

  const capabilities = useQuery({
    queryKey: ['capabilities', conn?.connector_id],
    queryFn: () => api.listCapabilities(conn!.connector_id),
    enabled: conn !== undefined,
  })

  const [last, setLast] = useState<{ capability: string; env: Envelope } | null>(null)

  const run = useMutation({
    mutationFn: (capabilityId: string) =>
      api.invoke({ connection_id: id, capability_id: capabilityId, input: {} }),
    onSuccess: (env, capabilityId) => setLast({ capability: capabilityId, env }),
  })

  if (connections.isPending) return <p className="muted">正在读取…</p>
  if (!conn) {
    return (
      <div className="card error-card">
        <p className="card-title">连接不存在</p>
        <p className="muted">下一步：返回连接列表确认它是否已被删除。</p>
        <button onClick={onBack}>返回</button>
      </div>
    )
  }

  return (
    <section>
      <div className="section-head">
        <div>
          <button className="link" onClick={onBack}>← 返回</button>
          <h1>{conn.label}</h1>
          <p className="muted small">{conn.connector_id} · {conn.id}</p>
        </div>
        {conn.connector_id.startsWith('bilibili') || conn.connector_id === 'xiaohongshu' ? (
          <button className="primary" onClick={() => onOpenScreen(id)}>
            打开远程登录
          </button>
        ) : null}
      </div>

      <h2>能力</h2>
      {capabilities.isPending && <p className="muted">正在读取能力…</p>}
      {capabilities.isError && (
        <div className="card error-card">
          <p className="card-title">读取能力失败</p>
          <p className="muted">发生了什么：{(capabilities.error as Error).message}</p>
          <p className="muted">下一步：确认连接器清单已加载（CONNECTORS_DIR）。</p>
        </div>
      )}
      {capabilities.data?.capabilities.length === 0 && (
        <div className="card">
          <p className="muted">该连接器尚未声明任何能力。</p>
        </div>
      )}

      <ul className="card-list">
        {capabilities.data?.capabilities.map((cap) => {
          const state = conn.capability_states[cap.id] ?? cap.support
          return (
            <li key={cap.id} className="card">
              <div className="card-row">
                <div>
                  <p className="card-title">{cap.title}</p>
                  <p className="muted small">{cap.id} · {cap.kind} · {cap.transport}</p>
                  <p className="muted small">{cap.description}</p>
                </div>
                <StatusBadge status={state.status} />
              </div>
              {cap.kind === 'query' && (
                <div className="card-actions">
                  <button onClick={() => run.mutate(cap.id)} disabled={run.isPending}>
                    {run.isPending && run.variables === cap.id ? '查询中…' : '试一下'}
                  </button>
                </div>
              )}
              {cap.kind === 'action' && (
                <p className="muted small">写操作本期未开放（框架已就位，能力全部关闭）。</p>
              )}
            </li>
          )
        })}
      </ul>

      {last && (
        <div className="card">
          <div className="card-row">
            <p className="card-title">结果 · {last.capability}</p>
            <StatusBadge status={last.env.outcome} />
          </div>
          {last.env.error && (
            <>
              <p className="error-text">{last.env.error.code}</p>
              <p className="muted">{last.env.error.message}</p>
            </>
          )}
          <p className="muted small">
            来源：{last.env.source.connection_label} · 数据时间：{last.env.data_time} ·
            查询时间：{last.env.queried_at} · 缓存：{last.env.cache?.hit ? '命中' : '未命中'}
          </p>
          <pre className="envelope">{JSON.stringify(last.env.data, null, 2)}</pre>
        </div>
      )}
    </section>
  )
}
