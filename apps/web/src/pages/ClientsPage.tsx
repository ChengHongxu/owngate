import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import { api, type Capability, type Client, type Connection, type Grant } from '../lib/api'
import { describeAuthError } from '../lib/http'
import { StatusBadge } from '../components/StatusBadge'
import { QueryFailure } from '../components/RequestFeedback'
import { HelpTip } from '../components/HelpTip'
import { ClientUsageGuide } from '../components/ClientUsageGuide'
import { PageDialog } from '../components/PageDialog'
import { Icon } from '../components/Icon'
import { analyzeGrantFields, normalizeVisibility, type GrantFieldAnalysis, type GrantFieldGroup, type GrantFieldKey } from '../lib/grant-fields'
import { routeHref } from '../lib/routing'
import './clients.css'

export function ClientsPage() {
  const search = useRouterState({ select: state => state.location.searchStr })
  const contextConnectionId = new URLSearchParams(search).get('connection_id') ?? ''
  const qc = useQueryClient()
  const clients = useQuery({ queryKey: ['clients'], queryFn: api.listClients })
  const grants = useQuery({ queryKey: ['grants'], queryFn: api.listGrants })
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.listConnections })
  const [adding, setAdding] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [issued, setIssued] = useState<{ id: string; label: string; token: string } | null>(null)
  const [guideClientId, setGuideClientId] = useState('')
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const addButton = useRef<HTMLButtonElement>(null)
  const guideButton = useRef<HTMLButtonElement>(null)
  const guideReturnFocus = useRef<HTMLElement | null>(null)
  const workspace = useRef<HTMLElement>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const create = useMutation({
    onMutate: () => qc.cancelQueries({ queryKey: ['clients'] }),
    mutationFn: async (input: { label: string; expires_at?: string | null }) => {
      const result = await api.createClient(input)
      // Only this component keeps the one-time token. Mutation/query caches
      // receive an explicit public object, never the token or its hash.
      if (mounted.current) {
        setIssued({ id: result.id, label: result.label, token: result.token })
        setCopied(false)
        setCopyError('')
      }
      const publicClient: Client = {
        id: result.id, label: result.label, revoked: result.revoked, created_at: result.created_at, expires_at: result.expires_at ?? null,
      }
      return publicClient
    },
    onSuccess: async (client) => {
      await qc.cancelQueries({ queryKey: ['clients'] })
      if (!mounted.current) return
      qc.setQueryData<{ clients: Client[] }>(['clients'], current => ({ clients: [...(current?.clients ?? []).filter(item => item.id !== client.id), client] }))
      setAdding(false)
      setSelectedId(client.id)
      guideReturnFocus.current = addButton.current
      setGuideClientId(client.id)
      await qc.invalidateQueries({ queryKey: ['clients'] })
    },
  })
  const revoke = useMutation({
    onMutate: () => qc.cancelQueries({ queryKey: ['clients'] }),
    mutationFn: api.revokeClient,
    onSuccess: async (_result, id) => {
      await qc.cancelQueries({ queryKey: ['clients'] })
      if (!mounted.current) return
      qc.setQueryData<{ clients: Client[] }>(['clients'], current => ({ clients: (current?.clients ?? []).map(client => client.id === id ? { ...client, revoked: true } : client) }))
      setSelectedId(current => current === id ? '' : current)
      setIssued((current) => current?.id === id ? null : current)
      setGuideClientId((current) => current === id ? '' : current)
      await qc.invalidateQueries({ queryKey: ['clients'] })
    },
  })

  if (clients.isPending || grants.isPending || connections.isPending) return <p className="muted">正在读取客户端与授权…</p>
  const loadError = clients.error ?? grants.error ?? connections.error
  if (!clients.data || !grants.data || !connections.data) {
    return <QueryFailure title="客户端加载失败" error={loadError} retry={() => { void clients.refetch(); void grants.refetch(); void connections.refetch() }} pending={clients.isFetching || grants.isFetching || connections.isFetching} />
  }
  const clientList = clients.data.clients
  const grantList = grants.data.grants
  const connectionList = connections.data.connections
  const contextConnection = connectionList.find(connection => connection.id === contextConnectionId)
  const activeClients = clientList.filter(client => !client.revoked)
  const revokedClients = clientList.filter(client => client.revoked)
  const selected = activeClients.find(client => client.id === selectedId) ?? activeClients[0]
  const guideClient = activeClients.find(client => client.id === guideClientId && client.id === selected?.id)

  function chooseClient(id: string) {
    setSelectedId(id)
    setIssued(current => current?.id === id ? current : null)
    setGuideClientId(current => current === id ? current : '')
  }

  function closeGuide() {
    setGuideClientId('')
    setIssued(null)
    setCopied(false)
    setCopyError('')
  }

  return (
    <section className="clients-page">
      <div className="section-head">
        <div>
          <div className="help-heading"><h1>客户端与授权</h1><HelpTip label="客户端授权说明">为客户端签发独立令牌，再为它选择连接和具体查询能力。签发令牌不会自动授予连接权限。</HelpTip></div>
          {contextConnection && <p className="muted small">当前连接：<Link to={routeHref({ name: 'connection', id: contextConnection.id })}>{contextConnection.label}</Link></p>}
        </div>
        <button ref={addButton} className="primary" aria-haspopup="dialog" disabled={create.isPending} onClick={() => { setIssued(null); setAdding(true); create.reset() }}>
          <Icon name="add" />添加客户端
        </button>
      </div>

      {contextConnectionId && !contextConnection && <p className="error-text" role="alert">链接中的连接已不存在，请在管理授权时重新选择连接。</p>}
      {loadError && <div className="inline-notice" role="alert"><p>刷新失败，显示上次的授权设置。</p><button onClick={() => { void clients.refetch(); void grants.refetch(); void connections.refetch() }}>重试</button></div>}

      {adding && <PageDialog title="添加客户端" onClose={() => setAdding(false)} dismissible={!create.isPending} returnFocusRef={addButton} footer={<button disabled={create.isPending} onClick={() => setAdding(false)}>取消</button>}><CreateClientForm pending={create.isPending} error={create.error} onCreate={(input) => { setIssued(null); create.mutate(input) }} /></PageDialog>}
      {revoke.isError && <p className="error-text" role="alert">撤销失败：{describeAuthError(revoke.error)}</p>}

      {!selected && (
        <div className="card">
          <p className="card-title">{clientList.length === 0 ? '还没有客户端' : '暂无可用客户端'}</p>
          <p className="muted">添加客户端后，为它分配查询权限。</p>
        </div>
      )}

      {selected && <>
        {activeClients.length > 1 && <div className="client-selector" role="group" aria-label="选择客户端">{activeClients.map(client => <button key={client.id} data-client-choice-id={client.id} aria-pressed={selected.id === client.id} onClick={() => chooseClient(client.id)}>{client.label}</button>)}</div>}
        <section ref={workspace} className="client-workspace" data-client-id={selected.id} aria-label={`${selected.label}的客户端设置`}>
          <div className="client-detail-heading">
            <div><h2>{selected.label}</h2><p className="muted small">{selected.expires_at ? `令牌有效至 ${new Date(selected.expires_at).toLocaleString()}` : '令牌不设到期时间'}</p></div>
            <div className="card-actions">
              <button ref={guideButton} aria-haspopup="dialog" onClick={() => { guideReturnFocus.current = guideButton.current; setGuideClientId(selected.id) }}><Icon name="book" />接入方法</button>
              <button className="danger" disabled={revoke.isPending} onClick={() => revoke.mutate(selected.id)}>{revoke.isPending && revoke.variables === selected.id ? '撤销中…' : '撤销客户端'}</button>
            </div>
          </div>
          <GrantEditor key={`${selected.id}:${contextConnectionId}`} client={selected} connections={connectionList} grants={grantList} initialConnectionId={contextConnection?.id ?? ''} />
        </section>
      </>}

      {guideClient && <PageDialog title={`接入方法 · ${guideClient.label}`} onClose={closeGuide} returnFocusRef={guideReturnFocus} footer={<button className="primary" onClick={() => { closeGuide(); requestAnimationFrame(() => workspace.current?.querySelector<HTMLElement>('.client-grants h2')?.focus()) }}>配置权限</button>}>
          {issued?.id === guideClient.id && <div className="client-issued-token" role="status">
            <p className="card-title">令牌已签发</p>
            <p className="muted small">令牌仅显示一次，请在关闭前保存。</p>
            <code className="secret">{issued.token}</code>
            <div className="card-actions">
              <button onClick={() => {
                setCopyError('')
                if (!navigator.clipboard) { setCopyError('当前浏览器无法自动复制，请选中上方令牌后复制。'); return }
                void navigator.clipboard.writeText(issued.token).then(() => setCopied(true)).catch(() => setCopyError('复制失败，请选中上方令牌后复制。'))
              }}><Icon name={copied ? 'check' : 'copy'} />{copied ? '已复制' : '复制令牌'}</button>
              <button onClick={() => setIssued(null)}>已保存，隐藏令牌</button>
            </div>
            {copyError && <p className="error-text">{copyError}</p>}
          </div>}
          <ClientUsageGuide key={guideClient.id} showHeading={false} />
      </PageDialog>}

      {revokedClients.length > 0 && <details className="client-history" data-client-history>
        <summary>已撤销（{revokedClients.length}）</summary>
        <ul>{revokedClients.map(client => <li key={client.id} data-client-revoked-id={client.id}><strong>{client.label}</strong></li>)}</ul>
      </details>}
    </section>
  )
}

function CreateClientForm({ pending, error, onCreate }: {
  pending: boolean
  error: unknown
  onCreate: (input: { label: string; expires_at?: string | null }) => void
}) {
  const [label, setLabel] = useState('')
  const [expiry, setExpiry] = useState('30')
  return (
    <form className="form client-create-form" onSubmit={(event) => { event.preventDefault(); if (label.trim()) onCreate({ label: label.trim(), expires_at: expiry ? new Date(Date.now() + Number(expiry) * 86_400_000).toISOString() : null }) }}>
      <div className="client-create-options">
      <label>客户端名称<input required maxLength={100} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="例如：个人助手、数据看板" disabled={pending} /></label>
      <label>令牌有效期<select value={expiry} onChange={(e) => setExpiry(e.target.value)} disabled={pending}><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option><option value="">长期有效，直到撤销</option></select></label>
      </div>
      {Boolean(error) && <p className="error-text" role="alert">签发失败：{describeAuthError(error)}</p>}
      <div className="card-actions"><button type="submit" className="primary" disabled={pending || !label.trim()}><Icon name="key" />{pending ? '签发中…' : '签发令牌'}</button><HelpTip label="令牌权限说明">签发令牌不会自动授予权限。可访问的连接、能力和数据范围需单独授权；密钥、令牌和 Cookie 始终隐藏。</HelpTip></div>
    </form>
  )
}

function GrantEditor({ client, connections, grants, initialConnectionId }: { client: Client; connections: Connection[]; grants: Grant[]; initialConnectionId: string }) {
  const clientGrants = grants.filter(grant => grant.client_id === client.id)
  const count = client.revoked ? 0 : clientGrants.filter(grant => grant.capabilities.length > 0 && connections.some(connection => connection.id === grant.connection_id)).length
  const missing = clientGrants.filter(grant => grant.capabilities.length > 0 && !connections.some(connection => connection.id === grant.connection_id))
  return (
    <section className="client-grants" aria-label={`${client.label}的权限总览`}>
      <div className="card-row"><div className="help-heading"><h2 tabIndex={-1}>查询权限</h2><HelpTip label="分配查询权限说明">每个连接分别授权。能力决定可以调用什么，返回字段决定查询结果中能看到什么；写操作保持关闭。</HelpTip></div><span className="muted small">已授权 {count} 个连接</span></div>
      {client.revoked && <p className="muted small">客户端已撤销，以下授权均已失效。</p>}
      {connections.length === 0 && <div className="card"><p className="muted">请先在「连接」页添加一个站点。</p></div>}
      <div className="client-grant-list">{connections.map(connection => <ConnectionGrantCard key={connection.id} client={client} connection={connection} saved={clientGrants.find(grant => grant.connection_id === connection.id)} initiallyOpen={connection.id === initialConnectionId} />)}</div>
      {missing.map(grant => <div className="card client-grant-unavailable" key={grant.connection_id}><strong>连接已不存在</strong><p className="mono muted small">{grant.connection_id}</p><p className="muted small">{grant.capabilities.join('、')} · 无法调用</p></div>)}
    </section>
  )
}

function fieldGroups(analysis: GrantFieldAnalysis): GrantFieldGroup[] {
  if (analysis.complete) return analysis.groups
  return ([['pii', '个人信息'], ['financial', '财务数据'], ['content', '网站内容']] as const).map(([key, label]) => analysis.groups.find(group => group.key === key) ?? { key, label, fields: [], count: 0 })
}

function ConnectionGrantCard({ client, connection, saved, initiallyOpen }: { client: Client; connection: Connection; saved: Grant | undefined; initiallyOpen: boolean }) {
  const [editing, setEditing] = useState(initiallyOpen && !client.revoked)
  const [notice, setNotice] = useState('')
  const capabilities = useQuery({ queryKey: ['capabilities', connection.connector_id, connection.id, connection.config], queryFn: () => api.listCapabilities(connection.connector_id, connection.id), staleTime: 30_000, refetchOnWindowFocus: false })
  const definitions = capabilities.data?.capabilities ?? []
  const granted = definitions.filter(cap => cap.kind === 'query' && cap.effect === 'read' && (saved?.capabilities.includes('*') || saved?.capabilities.includes(cap.id)))
  const proposals = saved?.capabilities.filter(id => id.startsWith('propose:')) ?? []
  const names = definitions.length ? [...granted.map(cap => cap.title), ...proposals.map(id => `提案：${definitions.find(cap => `propose:${cap.id}` === id)?.title ?? id.slice(8)}`), ...(saved?.capabilities.filter(id => id !== '*' && !id.startsWith('propose:') && !definitions.some(cap => cap.id === id)) ?? [])] : saved?.capabilities.map(id => id === '*' ? '全部查询' : id) ?? []
  const hasGrant = Boolean(saved?.capabilities.length)
  const policy = normalizeVisibility(saved?.visibility)
  const groups = fieldGroups(analyzeGrantFields(granted))
  const visible = groups.filter(group => policy[group.key]).map(group => group.label)
  const hidden = groups.filter(group => !policy[group.key]).map(group => group.label)
  useEffect(() => { if (client.revoked) setEditing(false) }, [client.revoked])
  return <article className={`card client-grant-card${editing ? ' client-grant-card-editing' : ''}`} data-grant-connection-id={connection.id} aria-label={`${connection.label}的授权`}>
    <div className="client-grant-heading"><div><h3>{connection.label}</h3><p className="muted small">{connection.connector_id}{connection.paused ? ' · 连接已暂停' : ''}</p></div><div className="card-actions"><span className={`status ${client.revoked || !hasGrant ? 'status-muted' : 'status-ok'}`}>{client.revoked ? '已失效' : hasGrant ? '已授权' : '未授权'}</span>{!editing && <button disabled={client.revoked || !capabilities.data} aria-expanded={false} onClick={() => { setNotice(''); setEditing(true) }}><Icon name={hasGrant ? 'edit' : 'add'} />{hasGrant ? '编辑授权' : '添加授权'}</button>}</div></div>
    {!editing && <>
      {hasGrant ? <div className="client-grant-summary"><div className="client-grant-capabilities" aria-label="已授权能力">{saved?.capabilities.includes('*') && definitions.length > 0 && <span className="client-grant-tag">全部查询</span>}{names.map((name, index) => <span className="client-grant-tag" key={index}>{name}</span>)}</div>{granted.length > 0 && groups.length > 0 && <p className="muted small">字段设置：{visible.map(label => `${label}开启`).join('、')}{visible.length > 0 && hidden.length > 0 ? ' · ' : ''}{hidden.map(label => `${label}关闭`).join('、')}</p>}</div> : <p className="muted small">未开放任何能力</p>}
      {notice && <p className="status-ok-text small" role="status">{notice}</p>}
    </>}
    {capabilities.isPending && <p className="muted small" role="status">正在读取能力说明…</p>}
    {capabilities.isError && <QueryFailure title="能力说明加载失败" error={capabilities.error} retry={() => { void capabilities.refetch() }} pending={capabilities.isFetching} />}
    {editing && capabilities.data && <ConnectionGrantForm key={JSON.stringify(saved ?? null)} client={client} connection={connection} saved={saved} capabilities={definitions} onCancel={() => setEditing(false)} onSaved={grant => { setEditing(false); setNotice(grant.capabilities.length ? '权限已保存' : '此连接的权限已全部撤销。') }} />}
  </article>
}

function ConnectionGrantForm({ client, connection, saved, capabilities, onCancel, onSaved }: { client: Client; connection: Connection; saved: Grant | undefined; capabilities: Capability[]; onCancel: () => void; onSaved: (grant: Grant) => void }) {
  const qc = useQueryClient()
  const queryCapabilities = capabilities.filter(cap => cap.kind === 'query' && cap.effect === 'read')
  const actionCapabilities = capabilities.filter(cap => cap.kind === 'action')
  const current = saved?.capabilities.includes('*') ? queryCapabilities.map(cap => cap.id) : (saved?.capabilities ?? []).filter(id => queryCapabilities.some(cap => cap.id === id))
  const [selected, setSelected] = useState(current)
  const [policy, setPolicy] = useState(() => normalizeVisibility(saved?.visibility))
  const initialProposals = saved?.capabilities.filter(id => actionCapabilities.some(cap => `propose:${cap.id}` === id)) ?? []
  const [proposalIds, setProposalIds] = useState(initialProposals)
  const unknown = saved?.capabilities.filter(id => id !== '*' && !queryCapabilities.some(cap => cap.id === id) && !actionCapabilities.some(cap => `propose:${cap.id}` === id)) ?? []
  const [retainedUnknown, setRetainedUnknown] = useState(unknown)
  const analysis = analyzeGrantFields(queryCapabilities.filter(cap => selected.includes(cap.id)))
  const groups = fieldGroups(analysis)
  const initialPolicy = normalizeVisibility(saved?.visibility)
  const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id))
  const dirty = !sameIds(selected, current) || !sameIds(proposalIds, initialProposals) || !sameIds(retainedUnknown, unknown) || (Object.keys(policy) as GrantFieldKey[]).some(key => policy[key] !== initialPolicy[key])
  const save = useMutation({
    onMutate: () => qc.cancelQueries({ queryKey: ['grants'] }),
    mutationFn: (ids: string[]) => api.setGrant({ client_id: client.id, connection_id: connection.id, capabilities: ids, visibility: { ...policy } }),
    onSuccess: grant => {
      qc.setQueryData<{ grants: Grant[] }>(['grants'], current => ({ grants: [...(current?.grants ?? []).filter(item => item.client_id !== grant.client_id || item.connection_id !== grant.connection_id), grant] }))
      void qc.invalidateQueries({ queryKey: ['grants'] })
      onSaved(grant)
    },
  })
  function submit() {
    if (save.isPending || retainedUnknown.length || !dirty) return
    const ids = saved?.capabilities.includes('*') && sameIds(selected, queryCapabilities.map(cap => cap.id)) ? ['*'] : selected
    save.mutate([...ids, ...proposalIds])
  }
  return (
    <form className="form tight client-grant-form" aria-label={`${connection.label}的授权`} onSubmit={event => { event.preventDefault(); submit() }}>
      <div className="client-grant-edit-layout">
      <div className="client-grant-query-area">
      <div className="card-row"><strong>允许查询</strong><span className="muted small">已选 {selected.length} 项{dirty ? ' · 未保存' : ''}</span></div>
      {saved?.capabilities.includes('*') && <p className="muted small">现有授权包含全部查询；取消某项并保存后改为指定能力。</p>}
      <fieldset className="client-capability-options" disabled={save.isPending}><legend className="sr-only">选择允许查询的能力</legend>
        {queryCapabilities.length === 0 ? <p className="muted small">没有可授权的查询能力</p> : <><div className="client-grant-select-actions"><button className="text-button" type="button" onClick={() => setSelected(queryCapabilities.map(cap => cap.id))}>全选</button><button className="text-button" type="button" onClick={() => setSelected([])}>清空</button></div>{queryCapabilities.map(cap => <div className={`client-capability-option${selected.includes(cap.id) ? ' is-selected' : ''}`} key={cap.id}><label><input type="checkbox" aria-label={cap.title} checked={selected.includes(cap.id)} onChange={event => setSelected(event.target.checked ? [...selected, cap.id] : selected.filter(id => id !== cap.id))} /><span>{cap.title}</span><StatusBadge status={(connection.capability_states[cap.id] ?? cap.support).status} /></label><HelpTip label={`${cap.title}说明`}>{cap.description}<p className="mono small">{cap.id}</p></HelpTip></div>)}</>}
      </fieldset>
      {unknown.length > 0 && <fieldset disabled={save.isPending}><legend>需要确认的历史授权</legend><p className="muted small">这些能力已不在当前目录中。取消后才能保存其他修改。</p>{unknown.map(id => <label className="client-field-option" key={id}><input type="checkbox" aria-label={id} checked={retainedUnknown.includes(id)} onChange={event => setRetainedUnknown(event.target.checked ? [...retainedUnknown, id] : retainedUnknown.filter(value => value !== id))} /><span className="mono small">{id}</span></label>)}</fieldset>}
      </div>
      {(selected.length > 0 || actionCapabilities.length > 0) && <div className="client-grant-field-area">
      {selected.length > 0 && <fieldset className="client-field-options" disabled={save.isPending}><legend><span className="help-heading">返回字段<HelpTip label="返回字段说明">能力决定允许调用什么，这里限制查询结果中显示哪些字段。分类来自所选能力的字段定义，一个字段可能同时受父级和自身分类限制；密钥、令牌与 Cookie 始终隐藏。变更同时作用于缓存及已有任务结果。</HelpTip></span></legend>
        {!analysis.complete && <p className="muted small">此能力未提供完整字段说明，可按数据类型设置范围。</p>}
        {groups.length === 0 ? <p className="muted small">所选能力没有可配置的字段分类。</p> : groups.map(group => <label className="client-field-option" key={group.key}><input type="checkbox" aria-label={group.label} checked={policy[group.key]} onChange={event => setPolicy({ ...policy, [group.key]: event.target.checked })} /><span><strong>{group.label}</strong>{group.fields.length > 0 && <span className="muted small client-field-examples">{group.fields.join('、')}</span>}</span></label>)}
      </fieldset>}
      {actionCapabilities.length > 0 && <details className="client-proposal-options field-help"><summary>操作提案权限（不会开放站点写操作）</summary><fieldset disabled={save.isPending} className="client-capability-options">{actionCapabilities.map(cap => <label key={cap.id} className="client-field-option"><input type="checkbox" checked={proposalIds.includes(`propose:${cap.id}`)} onChange={event => setProposalIds(event.target.checked ? [...proposalIds, `propose:${cap.id}`] : proposalIds.filter(id => id !== `propose:${cap.id}`))} />允许提交「{cap.title}」的具体内容供后台人工审阅</label>)}</fieldset></details>}
      </div>}
      </div>
      {save.isError && <p className="error-text" role="alert">保存失败：{describeAuthError(save.error)}</p>}
      <div className="card-actions client-grant-save">
        <button type="submit" className="primary" disabled={save.isPending || !dirty || retainedUnknown.length > 0}><Icon name="save" />{save.isPending ? '保存中…' : '保存授权'}</button>
        <button type="button" disabled={save.isPending} onClick={onCancel}>取消</button>
        {saved?.capabilities.length ? <button type="button" className="danger" disabled={save.isPending} onClick={() => save.mutate([])}>撤销此连接的全部权限</button> : null}
      </div>
    </form>
  )
}
