import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { api, type Capability, type Connection, type Connector, type CookieImportResult, type Envelope, type VerificationResult } from '../lib/api'
import { describeAuthError } from '../lib/http'
import { parseCookieJson, type CookieItem } from '../lib/cookies'
import { StatusBadge } from '../components/StatusBadge'
import { QueryFailure } from '../components/RequestFeedback'
import { QueryRequestFailure, QueryResult } from '../components/QueryResult'
import { SchemaFields } from '../components/SchemaFields'
import { HelpTip } from '../components/HelpTip'
import { PageDialog } from '../components/PageDialog'
import { ConnectionComparison } from '../components/ComparisonView'
import { Icon } from '../components/Icon'
import { configFields, fieldText, initialFields, inputFields, parseFields, type FormField } from '../lib/schema-fields'
import { productApi } from '../lib/product-api'
import { QueryRequestError } from '../lib/execution'
import { routeHref } from '../lib/routing'
import { invalidateConnectionStatus } from '../lib/connection-status'
import './connection-detail.css'

interface ConnectionDetailProps {
  id: string
  onBack: () => void
  onOpenScreen: (id: string) => void
}

const STATE_HELP: Record<string, string> = {
  unverified: '尚未在此连接上验证，试查后会更新状态。',
  unavailable: '最近调用未成功，可查看失败原因并重试。',
  needs_auth: '该能力需要有效的登录态或访问凭据。',
  needs_adapter: '最近返回的数据未通过适配解析，可查看失败节点。',
}

export function ConnectionDetailPage(props: ConnectionDetailProps) {
  // A detail URL can change without unmounting the route. Never carry draft
  // values or an in-flight result across connection identities.
  return <ConnectionDetail key={props.id} {...props} />
}

function useMounted() {
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  return mounted
}

function ConnectionDetail({ id, onBack, onOpenScreen }: ConnectionDetailProps) {
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.listConnections })
  const conn = connections.data?.connections.find((c) => c.id === id)
  const connectors = useQuery({ queryKey: ['connectors'], queryFn: api.listConnectors })
  const connector = connectors.data?.connectors.find((entry) => entry.id === conn?.connector_id)
  const qc = useQueryClient()

  const capabilities = useQuery({
    queryKey: ['capabilities', conn?.connector_id, conn?.id, conn?.config],
    queryFn: () => api.listCapabilities(conn!.connector_id, id),
    enabled: conn !== undefined,
  })

  const mounted = useMounted()
  const resultEpoch = useRef(0)
  const [resetVersion, setResetVersion] = useState(0)
  const [results, setResults] = useState<Record<string, Envelope>>({})
  const [verification, setVerification] = useState<{ result: VerificationResult; saved: boolean } | null>(null)
  const [verificationError, setVerificationError] = useState<unknown>(null)

  const applyVerification = (result: VerificationResult, saved: boolean) => {
    setVerificationError(null)
    setVerification({ result, saved })
    setResults((current) => ({ ...current, ...result.results }))
  }

  const verify = useMutation({
    mutationFn: async () => {
      const epoch = resultEpoch.current
      return { result: await api.verifyConnection(id), epoch }
    },
    onMutate: () => resultEpoch.current,
    onSuccess: ({ result, epoch }) => {
      if (mounted.current && epoch === resultEpoch.current) applyVerification(result, false)
    },
    onError: (error, _variables, epoch) => {
      if (mounted.current && epoch === resultEpoch.current) setVerificationError(error)
    },
    onSettled: () => { void invalidateConnectionStatus(qc) },
  })
  const clearResults = () => {
    resultEpoch.current++
    setResetVersion(resultEpoch.current)
    setResults({})
    setVerification(null)
    setVerificationError(null)
    verify.reset()
  }
  const pause = useMutation({ mutationFn: () => productApi.connectionState(id, { paused: !conn?.paused }), onSuccess: () => { clearResults(); void invalidateConnectionStatus(qc) } })

  const isBrowser = connector?.has_login === true
  const views = connector?.views?.filter(view => [view.source.capability, view.detail.capability].every(capabilityId => {
    const capability = capabilities.data?.capabilities.find(cap => cap.id === capabilityId)
    const state = conn?.capability_states[capabilityId]?.status ?? capability?.support.status
    return capability?.kind === 'query' && capability.effect === 'read' && !['disabled', 'unsupported'].includes(state ?? '')
  })) ?? []

  if (connections.isPending) return <p className="muted">正在读取…</p>
  if (connections.isError && !connections.data) return <QueryFailure title="无法读取连接" error={connections.error} retry={() => { void connections.refetch() }} pending={connections.isFetching} />
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
    <section className="connection-detail">
      <div className="section-head">
        <div>
          <button className="link" onClick={onBack}><Icon name="back" size={14} />返回</button>
          <h1>{conn.label}</h1>
          <p className="muted small">{connector?.title ?? conn.connector_id}</p>
        </div>
        <div className="card-actions">
          {views.map(view => <ConnectionComparison key={`${id}:${view.id}:${resetVersion}:${JSON.stringify(conn.config)}:${JSON.stringify(view)}`} connection={conn} connections={connections.data?.connections ?? []} view={view} source={capabilities.data!.capabilities.find(cap => cap.id === view.source.capability)!} />)}
          <Link className="button" to="/clients" search={{ connection_id: id }}><Icon name="clients" />客户端与权限</Link>
          <button disabled={pause.isPending} onClick={() => pause.mutate()}><Icon name={conn.paused ? 'play' : 'pause'} />{conn.paused ? '恢复连接' : '暂停连接'}</button>
          <button className="connection-verify" onClick={() => verify.mutate()} disabled={verify.isPending}><Icon name="verify" />{verify.isPending ? '验证中…' : '验证连接'}</button>
          {isBrowser ? (
          <button className="primary" onClick={() => onOpenScreen(id)}>
            <Icon name="login" />
            打开远程登录
          </button>
          ) : null}
        </div>
      </div>

      {connections.isRefetchError && <div className="inline-notice" role="alert"><p>连接信息刷新失败，当前显示上次数据。</p><button type="button" onClick={() => { void connections.refetch() }} disabled={connections.isFetching}>{connections.isFetching ? '刷新中…' : '重试刷新连接'}</button></div>}
      {verificationError != null && <p className="error-text" role="alert">验证失败：{describeAuthError(verificationError)}</p>}
      {pause.isError && <p className="error-text">状态修改失败：{describeAuthError(pause.error)}</p>}
      {conn.paused && <p className="muted"><Icon name="pause" /> 连接已暂停，恢复后才能查询。</p>}
      {verification && <VerificationSummary result={verification.result} saved={verification.saved} />}

      <div className="connection-overview-grid">
      <div className="card connection-settings" aria-label="连接信息">
        <div className="card-row"><h2 className="card-title">连接信息</h2><HelpTip label="接入说明">配置连接、完成授权并验证能力后，通过「客户端与权限」分配查询权限。未授权的连接仅在后台可用。连接 ID：{id}</HelpTip></div>
        <ConnectionScope key={`${id}:${conn.scope}:${conn.tags?.join(',')}`} connection={conn} onUpdated={clearResults} />
        {connector && <ConfigurationSection key={id} connection={conn} connector={connector} onUpdated={clearResults} />}
      </div>

      {(isBrowser || connector?.has_auth) && <div className="connection-access-summary">
      {isBrowser && <LoginStateSection id={id} onUpdated={clearResults} />}

      {connector && <CredentialsSection key={`${id}:${JSON.stringify(conn.config)}`} connectionId={id} connector={connector} onUpdated={(result) => {
        clearResults()
        applyVerification(result, true)
      }} />}
      </div>}
      </div>
      {connectors.isError && <p className="error-text">连接器配置读取失败，请刷新页面后重试。</p>}

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

      <ul className="card-list connection-capabilities">
        {capabilities.data?.capabilities.map((cap) => {
          const state = conn.capability_states[cap.id] ?? cap.support
          return (
            <CapabilityCard key={`${cap.id}:${resetVersion}`} connectionId={id} capability={cap} state={state} paused={conn.paused === true} result={results[cap.id]}
              onStart={() => setResults((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== cap.id)))}
              onResult={(env) => { if (resultEpoch.current === resetVersion) setResults((current) => ({ ...current, [cap.id]: env })) }} />
          )
        })}
      </ul>

    </section>
  )
}

function ConnectionScope({ connection, onUpdated }: { connection: Connection; onUpdated: () => void }) {
  const qc = useQueryClient()
  const mounted = useMounted()
  const [editing, setEditing] = useState(false)
  const [scope, setScope] = useState(connection.scope ?? 'personal')
  const [tags, setTags] = useState((connection.tags ?? []).join(', '))
  const [confirmed, setConfirmed] = useState(false)
  const save = useMutation({
    mutationFn: () => productApi.connectionState(connection.id, {
      scope, tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      ...(scope === 'organization' ? { confirm_organization: confirmed } : {}),
    }),
    onSuccess: () => {
      if (!mounted.current) return
      setEditing(false)
      onUpdated()
      void invalidateConnectionStatus(qc)
      void qc.invalidateQueries({ queryKey: ['grants'] })
    },
  })
  function beginEdit() {
    setScope(connection.scope ?? 'personal')
    setTags((connection.tags ?? []).join(', '))
    setConfirmed(false)
    save.reset()
    setEditing(true)
  }
  return <div className="connection-setting-section">
    <div className="connection-setting-row">
      <div className="connection-setting-content"><span className="muted small">范围与标签</span><div className="connection-summary-values"><span>{connection.scope === 'organization' ? '组织账户' : '个人账户'}</span>{connection.tags?.length ? connection.tags.map((tag) => <span className="connection-tag" key={tag}>{tag}</span>) : <span className="muted small">暂无标签</span>}</div></div>
      <button className="link" aria-label="编辑范围与标签" onClick={beginEdit}><Icon name="edit" size={14} />编辑</button>
    </div>
    {editing && <PageDialog title="编辑范围与标签" onClose={() => { setEditing(false); save.reset() }} dismissible={!save.isPending}><form className="form connection-dialog-form" aria-label="编辑范围与标签" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
      <label>账户范围<select value={scope} disabled={save.isPending} onChange={(event) => { save.reset(); setConfirmed(false); setScope(event.target.value as typeof scope) }}><option value="personal">个人</option><option value="organization">组织</option></select></label>
      <label>标签（逗号分隔）<input value={tags} disabled={save.isPending} onChange={(event) => { save.reset(); setTags(event.target.value) }} placeholder="例如：社交, 工作" /></label>
      {scope === 'organization' && <label className="checkbox-label"><input type="checkbox" required disabled={save.isPending} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我有权接入此组织账户；首次改为组织范围会撤销现有客户端授权，组织账户始终排除在默认汇总之外。</label>}
      {save.isError && <p className="error-text" role="alert">保存失败：{describeAuthError(save.error)}</p>}
      <div className="card-actions"><button type="submit" disabled={save.isPending || (scope === 'organization' && !confirmed)}>{save.isPending ? '保存中…' : '保存范围与标签'}</button><button type="button" disabled={save.isPending} onClick={() => { setEditing(false); save.reset() }}>取消</button></div>
    </form></PageDialog>}
  </div>
}

function LoginStateSection({ id, onUpdated }: { id: string; onUpdated: () => void }) {
  const qc = useQueryClient()
  const mounted = useMounted()
  const [importing, setImporting] = useState(false)
  const [text, setText] = useState('')
  const [localError, setLocalError] = useState('')
  const [imported, setImported] = useState<CookieImportResult | null>(null)

  const refreshConnections = () => {
    if (!mounted.current) return
    onUpdated()
    void invalidateConnectionStatus(qc)
  }

  const probe = useMutation({
    mutationFn: () => api.probe(id),
    onSuccess: refreshConnections,
  })

  const importCookies = useMutation({
    mutationFn: (cookies: CookieItem[]) => api.importCookies(id, cookies),
    onSuccess: (r) => {
      if (!mounted.current) return
      // 导入成功后清掉输入框，cookie 值不在页面上停留
      setText('')
      setImported(r)
      refreshConnections()
    },
  })

  const closeImport = () => {
    setImporting(false)
    setText('')
    setLocalError('')
    setImported(null)
    importCookies.reset()
  }

  return (
    <div className="card connection-login">
        <div className="card-row">
          <div className="connection-inline-title"><h2 className="card-title">登录态</h2><HelpTip label="登录态说明">检测该连接在服务器浏览器中是否仍处于登录状态。需要登录时，使用上方「打开远程登录」。</HelpTip></div>
          <button aria-label="立即检测登录态" onClick={() => probe.mutate()} disabled={probe.isPending}>
            {probe.isPending ? '检测中…' : '检测登录态'}
          </button>
        </div>
        {probe.data && (
          <div className="card-row">
            <StatusBadge status={probe.data.status} />
            {probe.data.reason && <p className="muted small">{probe.data.reason}</p>}
          </div>
        )}
        {probe.isError && <p className="error-text">检测失败：{describeAuthError(probe.error)}</p>}
      <div className="connection-cookie-import"><button type="button" className="link" onClick={() => setImporting(true)}>导入已有登录态</button></div>
      {importing && <PageDialog title="导入已有登录态" onClose={closeImport} dismissible={!importCookies.isPending}>
      <form
        className="form connection-dialog-form"
        aria-label="导入已有登录态"
        onSubmit={(e) => {
          e.preventDefault()
          setLocalError('')
          setImported(null)
          const parsed = parseCookieJson(text)
          if (!parsed.ok) return setLocalError(parsed.error)
          importCookies.mutate(parsed.cookies)
        }}
      >
        <div>
          <div className="connection-inline-title"><p className="card-title">导入 Cookie</p><HelpTip label="导入登录态说明">
            适合服务器登录会触发异地验证的站点：在自己电脑上登录后用浏览器扩展导出 cookie（JSON 数组），粘贴到这里。需要二次验证。
          </HelpTip></div>
        </div>
        <label>
          cookie JSON
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            spellCheck={false}
            autoComplete="off"
            disabled={importCookies.isPending}
            placeholder='[{"name": "SESSDATA", "value": "…", "domain": ".bilibili.com", "path": "/"}]'
          />
        </label>
        {localError && <p className="error-text">{localError}</p>}
        {importCookies.isError && (
          <p className="error-text">导入失败：{describeAuthError(importCookies.error)}</p>
        )}
        {imported && (
          <div>
            <p className={imported.logged_in ? 'card-title status-ok-text' : 'card-title'}>
              {imported.logged_in ? '✓ 已识别为登录状态' : '已导入，但未识别为登录状态'}
            </p>
            {!imported.logged_in && (
              <p className="muted small">下一步：确认导出时已登录，且包含清单声明的登录 cookie。</p>
            )}
            <ul className="plain-list small">
              {imported.cookies.map((c) => (
                <li key={`${c.domain}|${c.name}`} className="mono">
                  {c.name} <span className="muted">· {c.domain}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="card-actions">
          <button className="primary" type="submit" disabled={importCookies.isPending}>
            {importCookies.isPending ? '导入中…' : '导入'}
          </button>
          <button type="button" disabled={importCookies.isPending} onClick={closeImport}>{imported ? '完成' : '取消'}</button>
        </div>
      </form>
      </PageDialog>}
    </div>
  )
}

function VerificationSummary({ result, saved = false }: { result: VerificationResult; saved?: boolean }) {
  const checked = Object.values(result.results)
  const failed = checked.filter((entry) => entry.outcome === 'error').length
  return <div className="inline-notice connection-verification" role="status">
    <p>{saved ? '凭据已保存。' : ''}{result.verified ? `已验证 ${checked.length} 项能力。` : failed ? `${failed} 项验证失败。` : '连接尚未通过验证。'}结果已显示在对应能力中。</p>
  </div>
}

function configurationValue(field: FormField, config: Record<string, unknown>): string {
  const value = config[field.name] ?? field.schema.default
  if (value === undefined || value === null || value === '') return '未设置'
  if (field.schema.secret) return '已设置'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (field.schema.format === 'uri' || field.schema.format === 'url') {
    // A site may include a query token in its URL. The overview needs only
    // the destination; edit mode retains the configured value.
    try { const parsed = new URL(String(value)); return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname) } catch { return '网址待确认' }
  }
  return fieldText(value)
}

function ConfigurationSection({ connection, connector, onUpdated }: { connection: Connection; connector: Connector; onUpdated: () => void }) {
  const qc = useQueryClient()
  const mounted = useMounted()
  const fields = configFields(connector.config)
  const [editing, setEditing] = useState(false)
  const [values, setValues] = useState(() => initialFields(fields, connection.config))
  const [label, setLabel] = useState(connection.label)
  const save = useMutation({
    mutationFn: () => {
      if (!label.trim()) throw new Error('请填写连接名称')
      return api.updateConnection(connection.id, { label: label.trim(), config: parseFields(fields, values) })
    },
    onSuccess: (updated) => {
      if (!mounted.current) return
      setValues(initialFields(fields, updated.config))
      setLabel(updated.label)
      setEditing(false)
      void invalidateConnectionStatus(qc)
      void qc.invalidateQueries({ queryKey: ['credentials', connection.id] })
      onUpdated()
    },
  })
  return <div className="connection-setting-section">
    <div className="connection-setting-row">
      <div className="connection-setting-content"><span className="muted small">连接配置</span>{fields.length > 0 ? <dl className="connection-config-summary">{fields.map((field) => <div key={field.name}><dt>{field.schema.label ?? field.schema.title ?? field.name}</dt><dd>{configurationValue(field, connection.config)}</dd></div>)}</dl> : <p className="small">使用站点默认配置</p>}</div>
      <button className="link" aria-label="编辑连接配置" onClick={() => { setValues(initialFields(fields, connection.config)); setLabel(connection.label); save.reset(); setEditing(true) }}><Icon name="edit" size={14} />编辑</button>
    </div>
    {editing && <PageDialog title="编辑连接配置" onClose={() => { setEditing(false); save.reset() }} dismissible={!save.isPending}><form className="form connection-dialog-form" aria-label="编辑连接配置" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
        <label>名称<input value={label} required disabled={save.isPending} onChange={(event) => { save.reset(); setLabel(event.target.value) }} /></label>
        <SchemaFields fields={fields} values={values} onChange={(next) => { save.reset(); setValues(next) }} disabled={save.isPending} />
        {connector.has_auth && fields.some((field) => field.name === 'base_url') && <p className="muted small">更换站点网址会清除旧凭据，需要重新填写并验证。</p>}
        {save.isError && <p className="error-text" role="alert">保存失败：{describeAuthError(save.error)}</p>}
        <div className="card-actions"><button type="submit" disabled={save.isPending}>{save.isPending ? '保存中…' : '保存配置'}</button><button type="button" disabled={save.isPending} onClick={() => { setEditing(false); save.reset() }}>取消</button></div>
      </form></PageDialog>}
  </div>
}

function CapabilityCard({ connectionId, capability, state, paused, result, onStart, onResult }: {
  connectionId: string
  capability: Capability
  state: { status: string; reason?: string; probed_at?: string }
  paused: boolean
  result: Envelope | undefined
  onStart: () => void
  onResult: (result: Envelope) => void
}) {
  const qc = useQueryClient()
  const mounted = useMounted()
  const fields = inputFields(capability.input)
  const opener = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const isReadQuery = capability.kind === 'query' && capability.effect === 'read'
  const supported = state.status === 'supported' || state.status === 'partial'
  const canProbe = isReadQuery && !paused && !['disabled', 'unsupported'].includes(state.status)
  const stateHelp = STATE_HELP[state.status]
  const run = useMutation({
    mutationFn: async () => {
      if (!canProbe) throw new Error(paused ? '连接已暂停，恢复后才能查询。' : '此能力当前不可执行。')
      const inputStarted = Date.now()
      let input: Record<string, unknown>
      try { input = parseFields(fields, values) }
      catch (error) { throw new QueryRequestError(error, 'input', inputStarted) }
      const requestStarted = Date.now()
      try {
        if (!supported) {
          const result = await api.verifyConnection(connectionId, { capability_id: capability.id, input })
          const envelope = result.results[capability.id]
          if (!envelope) throw new Error('验证未返回查询结果')
          return envelope
        }
        return await api.invoke({ connection_id: connectionId, capability_id: capability.id, input, no_cache: true })
      } catch (error) {
        throw new QueryRequestError(error, 'request', requestStarted)
      }
    },
    onMutate: onStart,
    onSuccess: (envelope) => { if (mounted.current) onResult(envelope) },
    onSettled: () => { void invalidateConnectionStatus(qc) },
  })
  useEffect(() => {
    // A connection-wide verification can replace a previous transport error
    // in this card. Its new envelope is now the current observed result.
    if (result && run.isError) run.reset()
  }, [result])
  const task = useMutation({ mutationFn: () => {
    if (!canProbe || !supported) throw new Error('此能力当前不能作为任务查询。')
    return productApi.submitTask({ connection_id: connectionId, capability_id: capability.id, input: parseFields(fields, values) })
  } })
  const pending = run.isPending || task.isPending
  const hasFeedback = result !== undefined || run.isError || task.isError || task.data !== undefined
  const summary = run.isPending ? '正在查询…' : task.isPending ? '正在提交任务…' : run.isError ? '调用失败' : task.isError ? '任务提交失败' : result ? ({ success: '最近查询成功', partial: '最近查询部分成功', error: '最近查询失败' }[result.outcome]) : task.data ? '任务已排队' : !canProbe ? (paused ? '连接已暂停' : '当前不可试查') : fields.length > 0 ? `${fields.length} 项参数` : '无需参数'
  const failed = !pending && (run.isError || result?.outcome === 'error' || task.isError)
  return <li className="card capability-card" data-capability-id={capability.id} aria-label={capability.title}>
    <div className="capability-card-heading">
      <div className="connection-inline-title capability-card-title"><h3 className="card-title" title={capability.title}>{capability.title}</h3><HelpTip label={`${capability.title}说明`}>{capability.description}<p className="mono small">{capability.id} · {capability.transport === 'browser' ? '浏览器' : 'HTTP'}</p>{stateHelp && <p>{stateHelp}</p>}{state.reason && <p>{state.reason}</p>}</HelpTip></div>
      <StatusBadge status={state.status} />
    </div>
    <div className="capability-card-footer">
      <p className={`small capability-query-summary ${failed ? 'error-text' : 'muted'}`} role="status" title={summary}>{summary}</p>
      <button ref={opener} className="capability-open" type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}><Icon name={pending ? 'clock' : hasFeedback || !canProbe ? 'view' : 'play'} />{pending ? '查看进度' : hasFeedback ? '查看结果' : canProbe ? '试一下' : '查看详情'}</button>
    </div>
    {open && <PageDialog title={capability.title} size="wide" onClose={() => setOpen(false)} returnFocusRef={opener}>
      <div className="capability-workspace" data-capability-workspace={capability.id}>
        <div className="card-row"><StatusBadge status={state.status} /><HelpTip label={`${capability.title}查询说明`}>{capability.description}<p className="mono small">{capability.id} · {capability.transport === 'browser' ? '浏览器' : 'HTTP'}</p>{stateHelp && <p>{stateHelp}</p>}{state.reason && <p>{state.reason}</p>}</HelpTip></div>
        {paused ? <p className="muted small">连接已暂停，恢复后才能查询。</p> : !canProbe ? <p className="muted small">{state.reason ?? '此能力当前不可执行。'}</p> : !result && !run.isPending && state.probed_at && state.reason ? <p className="error-text capability-status-reason">上次验证：{state.reason}</p> : null}
        {isReadQuery && <form className="form tight" aria-label={`${capability.title}查询`} onSubmit={(event) => { event.preventDefault(); if (canProbe && !pending) run.mutate() }}>
          {fields.length > 0 && <div className="capability-fields"><SchemaFields fields={fields} values={values} onChange={setValues} disabled={pending || !canProbe} /></div>}
          <div className="card-actions"><button className="primary" type="submit" disabled={pending || !canProbe}><Icon name="play" />{run.isPending ? '查询中…' : supported ? '试一下' : '验证并试查'}</button><button type="button" disabled={pending || !canProbe || !supported} onClick={() => { if (!pending) task.mutate() }}><Icon name="tasks" />{task.isPending ? '提交中…' : '作为任务查询'}</button></div>
        </form>}
        {run.isPending && <p className="muted small" role="status">正在执行此能力…</p>}
        {run.isError && <QueryRequestFailure error={run.error} />}
        {task.isError && <p className="error-text" role="alert">任务提交失败：{describeAuthError(task.error)}</p>}
        {task.data && <p className="small" role="status">任务已排队 · <Link to={routeHref({ name: 'tasks', id: task.data.task_id })}>查看任务</Link></p>}
        {result && <div className="capability-result"><QueryResult envelope={result} capability={capability} title="最近结果" /></div>}
      </div>
    </PageDialog>}
  </li>
}

function CredentialsSection({ connectionId, connector, onUpdated }: { connectionId: string; connector: Connector; onUpdated: (result: VerificationResult) => void }) {
  const qc = useQueryClient()
  const mounted = useMounted()
  const [editing, setEditing] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const credentials = useQuery({
    queryKey: ['credentials', connectionId],
    queryFn: () => api.getCredentials(connectionId),
    enabled: connector.has_auth,
  })
  const saved = new Set(credentials.data?.fields.map((field) => field.key) ?? [])
  const fields = configFields(connector.auth?.fields).map((field) => ({
    ...field,
    schema: { ...field.schema, secret: field.schema.secret !== false },
    required: field.schema.required !== false && !saved.has(field.name),
  }))
  const save = useMutation({
    mutationFn: () => {
      const parsed = parseFields(fields, values)
      if (Object.keys(parsed).length === 0) throw new Error('请填写需要更新的凭据；检查现有凭据请使用「验证连接」')
      const next = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]))
      return api.setCredentials(connectionId, next)
    },
    onSuccess: (result) => {
      if (!mounted.current) return
      setValues({})
      setEditing(false)
      onUpdated(result)
      void qc.invalidateQueries({ queryKey: ['credentials', connectionId] })
      void invalidateConnectionStatus(qc)
    },
  })
  if (!connector.has_auth) return null
  return <div className="card connection-credentials">
    <div className="card-row">
      <div className="connection-inline-title"><h2 className="card-title">凭据</h2><HelpTip label="凭据说明">仅显示已设置状态。编辑时无需重新填写未修改的凭据；保存后会自动验证连接。</HelpTip></div>
      {credentials.data && <button className="link" onClick={() => { setValues({}); save.reset(); setEditing(true) }}><Icon name="key" size={14} />{saved.size ? '编辑凭据' : '配置凭据'}</button>}
    </div>
    {credentials.isPending && <p className="muted">正在读取凭据状态…</p>}
    {credentials.isError && <p className="error-text">无法读取凭据状态：{describeAuthError(credentials.error)}</p>}
    {credentials.data && <div className="connection-summary-values small">{saved.size ? credentials.data.fields.map((field) => <span key={field.key} title={`更新于 ${new Date(field.updated_at).toLocaleString()}`}>{fields.find((entry) => entry.name === field.key)?.schema.label ?? field.key} · 已设置</span>) : <span className="muted">尚未设置凭据</span>}</div>}
    {editing && fields.length > 0 ? <PageDialog title="编辑凭据" onClose={() => { setValues({}); setEditing(false); save.reset() }} dismissible={!save.isPending}><form className="form connection-dialog-form" aria-label="编辑凭据" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
      <SchemaFields fields={fields} values={values} onChange={(next) => { save.reset(); setValues(next) }} disabled={save.isPending || credentials.isPending} />
      {save.isError && <p className="error-text" role="alert">保存失败：{describeAuthError(save.error)}</p>}
      <div className="card-actions"><button className="primary" type="submit" disabled={save.isPending || credentials.isPending}>{save.isPending ? '保存并验证中…' : '保存并验证'}</button><button type="button" disabled={save.isPending} onClick={() => { setValues({}); setEditing(false); save.reset() }}>取消</button></div>
    </form></PageDialog> : fields.length === 0 ? <p className="error-text">连接器未提供凭据字段，请检查清单。</p> : null}
  </div>
}
