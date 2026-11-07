import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { extensionsApi, EXAMPLE_EXTENSION, enabledSelection, type ExtensionInput, type ExtensionPreview } from '../lib/extensions-api'
import { describeAuthError } from '../lib/http'
import { HelpTip } from '../components/HelpTip'
import { PageDialog } from '../components/PageDialog'
import './spatial-secondary.css'

export function ExtensionsPage() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['extensions'], queryFn: extensionsApi.list })
  const [importing, setImporting] = useState(false)
  const [format, setFormat] = useState<'manifest' | 'openapi'>('manifest')
  const [id, setId] = useState('')
  const [source, setSource] = useState('')
  const [preview, setPreview] = useState<{ input: ExtensionInput; result: ExtensionPreview } | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const check = useMutation({ mutationFn: async () => {
    const input: ExtensionInput = { format, source, ...(id.trim() ? { id: id.trim() } : {}) }
    const result = await extensionsApi.preview(input)
    return { input, result }
  }, onSuccess: (result) => { setPreview(result); setSelected([]) } })
  const install = useMutation({ mutationFn: async () => {
    if (!preview) throw new Error('请先预览扩展')
    return extensionsApi.install({ ...preview.input, enabled_capabilities: enabledSelection(preview.result, selected), preview_fingerprint: preview.result.fingerprint })
  }, onSuccess: (result) => {
    setNotice(`已安装「${result.title}」${result.version}，启用 ${result.enabled_capabilities.length} 个查询。请到「连接」创建此服务的连接并逐项验证。`)
    setImporting(false); setSource(''); setId(''); setPreview(null); setSelected([]); check.reset()
    void qc.invalidateQueries({ queryKey: ['extensions'] }); void qc.invalidateQueries({ queryKey: ['connectors'] })
  } })
  function changed() { setPreview(null); setSelected([]); setNotice(''); check.reset(); install.reset() }
  function closeImport() {
    if (busy) return
    setImporting(false); setSource(''); setId(''); setFormat('manifest'); setPreview(null); setSelected([]); check.reset(); install.reset()
  }
  const busy = check.isPending || install.isPending
  return <section><div className="section-head"><div className="help-heading"><h1>扩展导入</h1><HelpTip label="支持的格式与限制">导入接口定义，预览后选择只读查询。支持原生 YAML / JSON 清单或 OpenAPI 3.0，每次最多 128 KiB、50 个操作。支持固定服务器地址、单一 Bearer / API Key、单值参数和 JSON 响应。安装后创建连接并验证；未知浏览器站点需要专门适配。</HelpTip></div><button className="primary" onClick={() => { changed(); setImporting(true) }}>导入扩展</button></div>
    {notice && <p className="status-ok-text" role="status">{notice}</p>}
    {importing && <PageDialog title="导入扩展" size="wide" dismissible={!busy} onClose={closeImport}>
    <div className={`extension-workbench${preview ? ' with-preview' : ''}`}>
    <form className="form extension-source-form" onSubmit={(event) => { event.preventDefault(); setPreview(null); setSelected([]); setNotice(''); check.mutate() }}>
      <label>定义格式<select disabled={busy} value={format} onChange={(event) => { changed(); setFormat(event.target.value as 'manifest' | 'openapi') }}><option value="manifest">原生清单（YAML / JSON）</option><option value="openapi">OpenAPI 3.0（YAML / JSON）</option></select></label>
      <label>连接器 ID{format === 'openapi' ? '（必填）' : '（留空沿用清单 ID）'}<input disabled={busy} value={id} onChange={(event) => { changed(); setId(event.target.value) }} required={format === 'openapi'} pattern="[a-z][a-z0-9_-]{2,63}" placeholder="my_service" /></label>
      <div><label htmlFor="extension-source">接口定义</label><textarea id="extension-source" disabled={busy} value={source} onChange={(event) => { changed(); setSource(event.target.value) }} required rows={12} spellCheck={false} placeholder="在这里粘贴清单或 OpenAPI 定义…" /><p className="muted small">不要包含真实令牌或密码。</p></div>
      <div className="card-actions"><button className="primary" type="submit" disabled={busy}>{check.isPending ? '正在解析…' : '预览操作'}</button><button type="button" disabled={busy} onClick={() => { changed(); setFormat('manifest'); setId(''); setSource(EXAMPLE_EXTENSION) }}>填入原生清单示例</button></div>
      {check.isError && <p className="error-text" role="alert">预览失败：{describeAuthError(check.error)}</p>}
    </form>
    {preview && <div className="extension-preview"><h2>{preview.result.title} · {preview.result.version}</h2><p className="muted small">ID：{preview.result.id} · {preview.result.operations.length} 个操作。预览阶段全部禁用。</p>
      <p className="muted small">请先核对站点文档，确认勾选的 GET 操作只读取数据。写操作与不受支持的参数保持禁用；同一 ID 的安装版本固定，升级时请用新 ID。</p>
      <div className="table-wrap"><table><thead><tr><th>启用查询</th><th>操作</th><th>请求</th><th>可用范围</th></tr></thead><tbody>{preview.result.operations.map((operation) => <tr key={operation.id}><td><input type="checkbox" aria-label={`启用 ${operation.title}`} disabled={busy || !operation.eligible} checked={selected.includes(operation.id)} onChange={(event) => setSelected((previous) => event.target.checked ? [...previous, operation.id] : previous.filter((value) => value !== operation.id))} /></td><td>{operation.title}<br /><code>{operation.id}</code></td><td><code>{operation.method} {operation.path}</code></td><td>{operation.reason}</td></tr>)}</tbody></table></div>
      <details><summary>连接所需的配置与授权字段</summary><p className="muted small">安装后在「连接」中填写以下字段。</p><pre className="envelope">{JSON.stringify({ config: preview.result.config, auth: preview.result.auth,
        ...(preview.result.views ? { views: preview.result.views } : {}), ...(preview.result.verification ? { verification: preview.result.verification } : {}) }, null, 2)}</pre></details>
      <button className="primary" disabled={busy} onClick={() => install.mutate()}>{install.isPending ? '正在安装…' : `安装并启用 ${enabledSelection(preview.result, selected).length} 个查询`}</button>
      {install.isError && <p className="error-text" role="alert">安装失败：{describeAuthError(install.error)}</p>}
    </div>}
    </div></PageDialog>}
    <h2>已安装扩展</h2>{list.isPending && <p>正在读取扩展…</p>}{list.isError && <p className="error-text" role="alert">读取扩展失败：{describeAuthError(list.error)}</p>}
    {list.data?.extensions.length === 0 && <div className="card"><p className="muted">尚未安装扩展。</p></div>}
    <div className="secondary-extension-grid">{list.data?.extensions.map((extension) => <div className="card" key={extension.id}><div className="card-row"><p className="card-title">{extension.title} · {extension.version}</p><span className={`status ${extension.status === 'installed' ? 'status-ok' : 'status-warn'}`}>{extension.status === 'installed' ? '已安装' : '未加载'}</span></div><p className="muted small">{extension.id} · {extension.enabled_capabilities.length} 个查询</p>{extension.error && <p className="error-text">{extension.error}</p>}{extension.status === 'installed' && <><p className="muted small">在「连接」配置授权并验证查询。</p><details><summary>已选择的查询与版本指纹</summary><pre className="envelope">{JSON.stringify({ enabled_capabilities: extension.enabled_capabilities, fingerprint: extension.fingerprint }, null, 2)}</pre></details></>}</div>)}</div>
  </section>
}
