import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type CookieImportResult, type Envelope } from '../lib/api'
import { describeAuthError } from '../lib/http'
import { parseCookieJson, type CookieItem } from '../lib/cookies'
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

  // 浏览器类连接：有远程登录、cookie 导入与登录态探测
  const isBrowser =
    conn !== undefined &&
    (conn.connector_id.startsWith('bilibili') ||
      conn.connector_id === 'xiaohongshu' ||
      (capabilities.data?.capabilities.some((c) => c.transport === 'browser') ?? false))

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
        {isBrowser ? (
          <button className="primary" onClick={() => onOpenScreen(id)}>
            打开远程登录
          </button>
        ) : null}
      </div>

      {isBrowser && <LoginStateSection id={id} />}

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

function LoginStateSection({ id }: { id: string }) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [localError, setLocalError] = useState('')
  const [imported, setImported] = useState<CookieImportResult | null>(null)

  const refreshConnections = () => void qc.invalidateQueries({ queryKey: ['connections'] })

  const probe = useMutation({
    mutationFn: () => api.probe(id),
    onSuccess: refreshConnections,
  })

  const importCookies = useMutation({
    mutationFn: (cookies: CookieItem[]) => api.importCookies(id, cookies),
    onSuccess: (r) => {
      // 导入成功后清掉输入框，cookie 值不在页面上停留
      setText('')
      setImported(r)
      refreshConnections()
    },
  })

  return (
    <>
      <h2>登录态</h2>
      <div className="card">
        <div className="card-row">
          <div>
            <p className="card-title">检测登录态</p>
            <p className="muted small">用该连接的浏览器 profile 检查是否仍处于登录状态。</p>
          </div>
          <button onClick={() => probe.mutate()} disabled={probe.isPending}>
            {probe.isPending ? '检测中…' : '立即检测登录态'}
          </button>
        </div>
        {probe.data && (
          <div className="card-row">
            <StatusBadge status={probe.data.status} />
            {probe.data.reason && <p className="muted small">{probe.data.reason}</p>}
          </div>
        )}
        {probe.isError && <p className="error-text">检测失败：{describeAuthError(probe.error)}</p>}
      </div>

      <form
        className="card form"
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
          <p className="card-title">导入 cookie</p>
          <p className="muted small">
            适合服务器登录会触发异地验证的站点：在自己电脑上登录后用浏览器扩展导出 cookie（JSON 数组），粘贴到这里。需要二次验证。
          </p>
        </div>
        <label>
          cookie JSON
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            spellCheck={false}
            autoComplete="off"
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
        </div>
      </form>
    </>
  )
}
