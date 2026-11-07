import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Connection } from '../lib/api'
import { StatusBadge } from '../components/StatusBadge'
import { SchemaFields } from '../components/SchemaFields'
import { configFields, parseFields } from '../lib/schema-fields'
import { invalidateConnectionStatus } from '../lib/connection-status'
import { QueryFailure } from '../components/RequestFeedback'
import { HelpTip } from '../components/HelpTip'
import { PageDialog } from '../components/PageDialog'
import { Icon } from '../components/Icon'
import './spatial-primary.css'

export function ConnectionsPage({ onOpen }: { onOpen: (id: string) => void }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)

  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: api.listConnections,
  })

  const remove = useMutation({
    mutationFn: api.deleteConnection,
    onSuccess: () => void invalidateConnectionStatus(qc),
  })

  if (connections.isPending) return <p className="muted">正在读取连接…</p>
  if (connections.isError) {
    return <QueryFailure title="连接加载失败" error={connections.error} retry={() => { void connections.refetch() }} pending={connections.isFetching} />
  }

  const list = connections.data.connections

  return (
    <section className="connections-page">
      <div className="section-head">
        <h1>连接</h1>
        <button className="primary" onClick={() => setAdding(true)}>
          <Icon name="add" />添加连接
        </button>
      </div>

      {adding && (
        <AddConnectionForm
          onCancel={() => setAdding(false)}
          onDone={(connection) => {
            setAdding(false)
            void invalidateConnectionStatus(qc)
            onOpen(connection.id)
          }}
        />
      )}

      {remove.isError && <p className="error-text">删除失败：{(remove.error as Error).message}</p>}

      {list.length === 0 ? (
        <div className="card">
          <p className="card-title">还没有连接</p>
          <p className="muted">添加网站并完成授权。</p>
        </div>
      ) : (
        <ul className="card-list connections-grid">
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
  return (
    <li className="card">
      <div className="card-row">
        <div>
          <p className="card-title">{conn.label}</p>
          <p className="muted small">{conn.connector_id} · {conn.id}</p>
        </div>
        <StatusBadge status={conn.health.status} />
      </div>
      {conn.health.reason && <p className="muted small">{conn.health.reason}</p>}
      <div className="card-actions">
        <button onClick={onOpen}>查看<Icon name="forward" /></button>
        <button className="danger" onClick={onDelete}><Icon name="trash" />删除</button>
      </div>
    </li>
  )
}

function AddConnectionForm({ onDone, onCancel }: { onDone: (connection: Connection) => void; onCancel: () => void }) {
  const [connectorId, setConnectorId] = useState('bilibili')
  const [step, setStep] = useState(1)
  const [scope, setScope] = useState<'personal' | 'organization'>('personal')
  const [confirmed, setConfirmed] = useState(false)
  const [label, setLabel] = useState('')
  const [config, setConfig] = useState<Record<string, string>>({})

  const connectors = useQuery({ queryKey: ['connectors'], queryFn: api.listConnectors })
  const selectedConnector = connectors.data?.connectors.find((c) => c.id === connectorId)
  useEffect(() => {
    if (connectors.data && !connectors.data.connectors.some((connector) => connector.id === connectorId)) {
      setConnectorId(connectors.data.connectors[0]?.id ?? '')
      setConfig({})
    }
  }, [connectors.data, connectorId])

  // 当切换 connector 时，用默认值填充 config
  const fields = configFields(selectedConnector?.config)

  const create = useMutation({
    mutationFn: () => {
      if (!selectedConnector) throw new Error('请先选择可用的站点类型')
      const finalConfig = parseFields(fields, config)
      return api.createConnection({
        connector_id: connectorId,
        label: label.trim() || connectorId,
        config: finalConfig,
        scope,
        ...(scope === 'organization' ? { confirm_organization: confirmed } : {}),
      })
    },
    onSuccess: onDone,
  })

  return (
    <PageDialog title="添加连接" onClose={onCancel} dismissible={!create.isPending}>
    <form
      className="form connection-create-form"
      aria-label="添加连接"
      onSubmit={(e) => {
        e.preventDefault()
        if (step === 1) setStep(2)
        else create.mutate()
      }}
    >
      <div className="help-heading"><p className="muted small">第 {step} / 2 步</p><HelpTip label="添加连接说明">{step === 1 ? '先选择网站类型和账户范围。' : '填写这个连接的名称与配置，下一步完成授权。'}</HelpTip></div>
      {step === 1 && <>
      <label>
        站点类型
        {connectors.data ? (
          <select
            value={connectorId}
            disabled={create.isPending}
            onChange={(e) => {
              setConnectorId(e.target.value)
              setConfig({}) // 清空 config，避免字段串
            }}
          >
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
      <label>账户范围<select value={scope} disabled={create.isPending} onChange={(e) => { setScope(e.target.value as typeof scope); setConfirmed(false) }}><option value="personal">个人账户</option><option value="organization">组织账户</option></select></label>
      {scope === 'organization' && <label className="checkbox-label"><input type="checkbox" required disabled={create.isPending} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />我有权接入这个组织账户。组织连接不自动参与全部查询，也不会自动授权给任何客户端。</label>}
      </>}
      {step === 2 && <>
      <label>
        名称
        <input
          value={label}
          disabled={create.isPending}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="例如：A中转站-主号"
        />
      </label>
      <SchemaFields fields={fields} values={config} onChange={setConfig} disabled={create.isPending} />
      </>}
      {connectors.isError && <p className="error-text">无法读取站点类型，请稍后重试。</p>}
      {create.isError && (
        <p className="error-text">添加失败：{(create.error as Error).message}</p>
      )}
      <div className="card-actions">
        {step === 2 && <button type="button" disabled={create.isPending} onClick={() => setStep(1)}>上一步</button>}
        <button className="primary" type="submit" disabled={create.isPending || !selectedConnector || (scope === 'organization' && !confirmed)}>
          {create.isPending ? '添加中…' : step === 1 ? '继续填写配置' : '添加并继续授权'}
        </button>
        <button type="button" disabled={create.isPending} onClick={onCancel}>取消</button>
      </div>
    </form>
    </PageDialog>
  )
}
