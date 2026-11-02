import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Connection } from '../lib/api'
import { StatusBadge } from '../components/StatusBadge'

export function ConnectionsPage({ onOpen }: { onOpen: (id: string) => void }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)

  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: api.listConnections,
  })

  const remove = useMutation({
    mutationFn: api.deleteConnection,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['connections'] }),
  })

  if (connections.isPending) return <p className="muted">正在读取连接…</p>
  if (connections.isError) {
    return (
      <div className="card error-card">
        <p className="card-title">读取连接失败</p>
        <p className="muted">发生了什么：{(connections.error as Error).message}</p>
        <p className="muted">下一步：确认已登录后台，且服务正在运行。</p>
      </div>
    )
  }

  const list = connections.data.connections

  return (
    <section>
      <div className="section-head">
        <h1>连接</h1>
        <button className="primary" onClick={() => setAdding((v) => !v)}>
          {adding ? '取消' : '添加连接'}
        </button>
      </div>

      {adding && (
        <AddConnectionForm
          onDone={() => {
            setAdding(false)
            void qc.invalidateQueries({ queryKey: ['connections'] })
          }}
        />
      )}

      {list.length === 0 ? (
        <div className="card">
          <p className="card-title">还没有连接</p>
          <p className="muted">点「添加连接」，先选择站点类型，再完成授权。每一步只做一个决定。</p>
        </div>
      ) : (
        <ul className="card-list">
          {list.map((c) => (
            <ConnectionCard
              key={c.id}
              conn={c}
              onOpen={() => onOpen(c.id)}
              onDelete={() => remove.mutate(c.id)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function ConnectionCard({
  conn,
  onOpen,
  onDelete,
}: {
  conn: Connection
  onOpen: () => void
  onDelete: () => void
}) {
  // 整体健康度：「任一能力需要授权」优先展示为需要重新登录
  const states = Object.values(conn.capability_states)
  const needsAuth = states.some((s) => s.status === 'needs_auth')
  const overall = needsAuth ? 'needs_auth' : states.length === 0 ? 'healthy' : 'healthy'

  return (
    <li className="card">
      <div className="card-row">
        <div>
          <p className="card-title">{conn.label}</p>
          <p className="muted small">{conn.connector_id} · {conn.id}</p>
        </div>
        <StatusBadge status={overall} />
      </div>
      <div className="card-actions">
        <button onClick={onOpen}>查看</button>
        <button className="danger" onClick={onDelete}>删除</button>
      </div>
    </li>
  )
}

function AddConnectionForm({ onDone }: { onDone: () => void }) {
  const [connectorId, setConnectorId] = useState('newapi')
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')

  const connectors = useQuery({ queryKey: ['connectors'], queryFn: api.listConnectors })

  const create = useMutation({
    mutationFn: () =>
      api.createConnection({
        connector_id: connectorId,
        label: label.trim() || connectorId,
        config: { base_url: baseUrl.trim() },
      }),
    onSuccess: onDone,
  })

  return (
    <form
      className="card form"
      onSubmit={(e) => {
        e.preventDefault()
        create.mutate()
      }}
    >
      <label>
        站点类型
        {connectors.data ? (
          <select value={connectorId} onChange={(e) => setConnectorId(e.target.value)}>
            {connectors.data.connectors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title} ({c.id})
              </option>
            ))}
          </select>
        ) : (
          <input value={connectorId} disabled placeholder="加载中..." />
        )}
      </label>
      <label>
        名称
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="例如：A中转站-主号"
        />
      </label>
      <label>
        站点网址
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://example.com"
        />
      </label>
      {create.isError && (
        <p className="error-text">添加失败：{(create.error as Error).message}</p>
      )}
      <div className="card-actions">
        <button className="primary" type="submit" disabled={create.isPending}>
          {create.isPending ? '添加中…' : '添加'}
        </button>
      </div>
    </form>
  )
}
