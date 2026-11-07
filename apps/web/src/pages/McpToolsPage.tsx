import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { mcpApi } from '../lib/mcp-api'
import { describeAuthError } from '../lib/http'
import { HelpTip } from '../components/HelpTip'
import { PageDialog } from '../components/PageDialog'
import './spatial-secondary.css'

export function McpToolsPage() {
  const qc = useQueryClient()
  const tools = useQuery({ queryKey: ['mcp-tools'], queryFn: mcpApi.list, refetchInterval: 15_000 })
  const clients = useQuery({ queryKey: ['clients'], queryFn: api.listClients })
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.listConnections })
  const grants = useQuery({ queryKey: ['grants'], queryFn: api.listGrants })
  const [adding, setAdding] = useState(false)
  const [clientId, setClientId] = useState(''), [connectionId, setConnectionId] = useState('')
  const [capabilityId, setCapabilityId] = useState(''), [name, setName] = useState('')
  const [notice, setNotice] = useState('')
  const selectedConnection = connections.data?.connections.find(connection => connection.id === connectionId)
  const capabilities = useQuery({ queryKey: ['capabilities', selectedConnection?.connector_id, connectionId, selectedConnection?.config],
    queryFn: () => api.listCapabilities(selectedConnection!.connector_id, connectionId), enabled: adding && selectedConnection !== undefined })
  const currentGrant = grants.data?.grants.find(grant => grant.client_id === clientId && grant.connection_id === connectionId)
  const availableCapabilities = capabilities.data?.capabilities.filter(cap => cap.kind === 'query' && cap.effect === 'read' && (currentGrant?.capabilities.includes('*') || currentGrant?.capabilities.includes(cap.id))) ?? []
  const activeClients = clients.data?.clients.filter(client => !client.revoked && (!client.expires_at || Date.parse(client.expires_at) > Date.now())) ?? []
  const availableConnections = connections.data?.connections.filter(connection => grants.data?.grants.some(grant => grant.client_id === clientId && grant.connection_id === connection.id && grant.capabilities.some(cap => !cap.startsWith('propose:')))) ?? []
  const count = tools.data?.tools.filter(tool => tool.client_id === clientId).length ?? 0
  const create = useMutation({ mutationFn: () => mcpApi.create({ client_id: clientId, name: name.trim(), connection_id: connectionId, capability_id: capabilityId }),
    onSuccess: async () => { setAdding(false); setName(''); setNotice('工具已固定，已通知连接中的 MCP 客户端刷新工具目录。'); await qc.invalidateQueries({ queryKey: ['mcp-tools'] }) } })
  const remove = useMutation({ mutationFn: mcpApi.remove,
    onSuccess: async () => { setNotice('工具已移除，已通知连接中的 MCP 客户端刷新工具目录。'); await qc.invalidateQueries({ queryKey: ['mcp-tools'] }) } })
  const error = tools.error ?? clients.error ?? connections.error ?? grants.error ?? remove.error
  const canCreate = activeClients.some(client => client.id === clientId) && availableConnections.some(connection => connection.id === connectionId) && availableCapabilities.some(cap => cap.id === capabilityId) && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name.trim()) && count < 10
  const loading = tools.isPending || clients.isPending || connections.isPending || grants.isPending
  function closeForm() {
    if (create.isPending) return
    setAdding(false); setClientId(''); setConnectionId(''); setCapabilityId(''); setName(''); create.reset()
  }

  return <section>
    <div className="section-head"><div className="help-heading"><h1>MCP 常用工具</h1><HelpTip label="使用说明">固定已授权的常用查询，每个客户端最多 10 个。固定工具保留完整参数说明，不会新增授权。通用工具始终保留；权限、角色或令牌变动立即生效。</HelpTip></div><button className="primary" disabled={loading} onClick={() => { setClientId(''); setConnectionId(''); setCapabilityId(''); setName(''); create.reset(); setAdding(true) }}>添加工具</button></div>
    {error && <p className="error-text" role="alert">{describeAuthError(error)}</p>}
    {notice && <p role="status">{notice}</p>}
    {loading ? <p className="muted">正在读取工具与授权…</p> : <>
      {adding && <PageDialog title="添加常用工具" size="wide" onClose={closeForm} dismissible={!create.isPending}>
      <form className="form secondary-form-grid" onSubmit={event => { event.preventDefault(); if (canCreate) { setNotice(''); create.mutate() } }}>
        <label>客户端<select value={clientId} disabled={create.isPending} onChange={event => { setClientId(event.target.value); setConnectionId(''); setCapabilityId(''); setNotice(''); create.reset() }}><option value="">请选择已授权的客户端</option>{activeClients.map(client => <option key={client.id} value={client.id}>{client.label}</option>)}</select></label>
        {clientId && <>
          <p className="muted small">此客户端已固定 {count} / 10 个工具。</p>
          <label>查询连接<select value={connectionId} disabled={create.isPending} onChange={event => { setConnectionId(event.target.value); setCapabilityId('') }}><option value="">请选择已授权的连接</option>{availableConnections.map(connection => <option key={connection.id} value={connection.id}>{connection.label}</option>)}</select></label>
          {availableConnections.length === 0 && <p className="muted">这个客户端还没有查询授权。先到「客户端」选择连接与查询能力。</p>}
        </>}
        {selectedConnection && <>
          <label>查询能力<select value={capabilityId} disabled={create.isPending || capabilities.isPending} onChange={event => setCapabilityId(event.target.value)}><option value="">请选择查询能力</option>{availableCapabilities.map(cap => <option key={cap.id} value={cap.id}>{cap.title} · {cap.id}</option>)}</select></label>
          {availableCapabilities.length === 0 && !capabilities.isPending && <p className="muted">没有当前可固定的查询能力。请检查客户端授权与账户角色。</p>}
        </>}
        <div className="schema-field"><div className="field-label"><label htmlFor="mcp-tool-name">工具名称</label><HelpTip label="工具名称说明">使用英文字母开头，只包含字母、数字、下划线或短横线。名称应说明查询用途。</HelpTip></div><input id="mcp-tool-name" required maxLength={64} pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" placeholder="例如：daily_summary" autoComplete="off" value={name} disabled={create.isPending} onChange={event => setName(event.target.value)} /></div>
        {capabilities.isError && <p className="error-text" role="alert">读取查询能力失败：{describeAuthError(capabilities.error)}</p>}
        {create.isError && <p className="error-text" role="alert">固定失败：{describeAuthError(create.error)}</p>}
        <div className="card-actions"><button className="primary" type="submit" disabled={!canCreate || create.isPending}>{create.isPending ? '固定中…' : '验证身份并固定工具'}</button><button type="button" disabled={create.isPending} onClick={closeForm}>取消</button></div>
      </form></PageDialog>}
      {tools.data?.tools.length === 0 && <div className="card">还没有固定工具。通用 MCP 查询工具已经可用，可按需添加常用查询。</div>}
      <ul className="card-list secondary-tool-grid">{tools.data?.tools.map(tool => <li className="card" key={tool.id}>
        <div className="card-row"><strong>{tool.name}</strong><span className={`status ${tool.available ? 'status-ok' : 'status-muted'}`}>{tool.available ? '✓ 已授权查询' : '× 当前无查询权限'}</span></div>
        <p className="muted small">客户端：{clients.data?.clients.find(client => client.id === tool.client_id)?.label ?? tool.client_id} · 连接：{connections.data?.connections.find(connection => connection.id === tool.connection_id)?.label ?? tool.connection_id}</p>
        <p className="muted small">{tool.capability_id}</p>
        {!tool.available && <p className="muted small">授权、账户角色或客户端状态已变更，这个工具已从客户端目录隐藏。移除后可重新选择。</p>}
        <div className="card-actions"><button className="danger" disabled={remove.isPending} onClick={() => { setNotice(''); remove.mutate(tool.id) }}>移除工具</button></div>
      </li>)}</ul>
    </>}
  </section>
}
