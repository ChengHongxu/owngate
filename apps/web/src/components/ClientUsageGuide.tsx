import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { clientUsage } from '../lib/client-usage'
import { Icon } from './Icon'
import './ClientUsageGuide.css'

const METHODS = ['MCP', 'HTTP API', 'CLI'] as const

export function ClientUsageGuide({ serverUrl, showHeading = true }: { serverUrl?: string; showHeading?: boolean }) {
  const [method, setMethod] = useState<(typeof METHODS)[number]>('MCP')
  const tabId = useId()
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const usage = clientUsage(serverUrl ?? (typeof window === 'undefined' ? '' : window.location.origin))
  if (!usage) return <p className="muted small">请从可访问的 OwnGate 地址打开此页，查看接入方法。</p>

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number
    switch (event.key) {
      case 'ArrowRight': next = (index + 1) % METHODS.length; break
      case 'ArrowLeft': next = (index + METHODS.length - 1) % METHODS.length; break
      case 'Home': next = 0; break
      case 'End': next = METHODS.length - 1; break
      default: return
    }
    const nextMethod = METHODS[next]
    if (!nextMethod) return
    event.preventDefault()
    setMethod(nextMethod)
    tabs.current[next]?.focus()
  }

  return <section className="client-usage-guide" aria-label="客户端接入方法">
    {showHeading && <h3>接入方法</h3>}
    <div className="client-usage-tabs" role="tablist" aria-label="接入方式">{METHODS.map((item, index) => <button
      key={item} ref={element => { tabs.current[index] = element }} type="button" role="tab"
      id={`${tabId}-tab-${index}`} aria-controls={`${tabId}-panel-${index}`} aria-selected={method === item}
      tabIndex={method === item ? 0 : -1} onClick={() => setMethod(item)} onKeyDown={event => moveTab(event, index)}
    >{item}</button>)}</div>
    <p className="muted small">三种方式共用此客户端的令牌和授权。</p>
    <div className="client-usage-panel" role="tabpanel" id={`${tabId}-panel-0`} aria-labelledby={`${tabId}-tab-0`} hidden={method !== 'MCP'} tabIndex={0}>
      <p className="small">添加 MCP 服务，传输方式选择 Streamable HTTP。</p>
      <UsageSnippet label="服务地址" value={usage.mcpUrl} />
      <UsageSnippet label="认证请求头" value="Authorization: Bearer <客户端令牌>" />
      <details className="client-usage-extra field-help"><summary>客户端仅支持 stdio？</summary>
        <p className="muted small">先配置 OwnGate CLI，再将启动命令填入客户端。</p>
        <UsageSnippet label="配置 CLI" value={usage.loginCommand} />
        <UsageSnippet label="启动命令" value={usage.stdioCommand} />
        <CliEntryHelp />
      </details>
    </div>
    <div className="client-usage-panel" role="tabpanel" id={`${tabId}-panel-1`} aria-labelledby={`${tabId}-tab-1`} hidden={method !== 'HTTP API'} tabIndex={0}>
      <UsageSnippet label="1. 查看已授权连接" value={usage.listConnectionsCommand} />
      <UsageSnippet label="2. 调用查询能力" value={usage.invokeCommand} />
      <details className="client-usage-extra field-help"><summary>能力与刷新</summary>
        <p className="muted small">从连接列表取连接 ID，再查看已授权的能力及其输入参数。</p>
        <UsageSnippet label="查看已授权能力" value={usage.listCapabilitiesCommand} />
        <p className="muted small">定时刷新可重复调用同一接口。需要每次向站点查询时，在请求中加入 <code>"no_cache": true</code>；仍需遵守站点限流。</p>
      </details>
    </div>
    <div className="client-usage-panel" role="tabpanel" id={`${tabId}-panel-2`} aria-labelledby={`${tabId}-tab-2`} hidden={method !== 'CLI'} tabIndex={0}>
      <UsageSnippet label="1. 配置 OwnGate CLI" value={usage.loginCommand} />
      <UsageSnippet label="2. 查看已授权项目" value={usage.discoverCommands} />
      <UsageSnippet label="3. 执行查询" value={usage.queryCommand} />
      <details className="client-usage-extra field-help"><summary>命令与参数说明</summary>
        <CliEntryHelp />
        <p className="muted small">连接可使用名称；能力 ID 替换为列表中的值。需要参数时，使用 <code>--input</code> 传入 JSON 对象。定时执行可将查询命令加入调度器。</p>
      </details>
    </div>
  </section>
}

function CliEntryHelp() {
  return <p className="muted small">在已构建的工程目录，可用 <code>node apps/cli/dist/bin.js</code> 替代命令中的 <code>owngate</code>。</p>
}

function UsageSnippet({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState('')
  const [failed, setFailed] = useState(false)
  return <div className="client-usage-snippet">
    <div className="client-usage-snippet-label"><span className="muted small">{label}</span><button type="button" className="text-button" onClick={() => {
      setFailed(false)
      if (!navigator.clipboard) { setFailed(true); return }
      void navigator.clipboard.writeText(value).then(() => setCopied(value)).catch(() => setFailed(true))
    }} aria-label={`复制${label}`}><Icon name={copied === value ? 'check' : 'copy'} size={14} />{copied === value ? '已复制' : '复制'}</button></div>
    <pre className="client-usage-code"><code>{value}</code></pre>
    {failed && <p className="error-text small" role="status">无法自动复制，请选中上方内容复制。</p>}
  </div>
}
