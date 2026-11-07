import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Capability, type Connection } from '../lib/api'
import { describeAuthError } from '../lib/http'
import { monitorsApi, monitorResultText, runResultText, type Monitor, type MonitorInput, type SmtpChannel, type SmtpInput } from '../lib/monitors-api'
import { inputFields, initialFields, parseFields } from '../lib/schema-fields'
import { SchemaFields } from '../components/SchemaFields'
import { HelpTip } from '../components/HelpTip'
import { PageDialog } from '../components/PageDialog'
import './spatial-secondary.css'

const stamp = (value: string | null) => value ? new Date(value).toLocaleString() : '—'
export function MonitorsPage() {
  const qc = useQueryClient()
  const monitors = useQuery({ queryKey: ['monitors'], queryFn: monitorsApi.list, refetchInterval: 15_000 })
  const channels = useQuery({ queryKey: ['notification-channels'], queryFn: monitorsApi.channels })
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.listConnections })
  const [editChannel, setEditChannel] = useState<SmtpChannel | 'new' | null>(null)
  const [editMonitor, setEditMonitor] = useState<Monitor | 'new' | null>(null)
  const [notice, setNotice] = useState('')
  const refresh = async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['monitors'] }), qc.invalidateQueries({ queryKey: ['notification-channels'] })]) }
  const operation = useMutation({
    mutationFn: async (input: { action: 'run' | 'toggle' | 'delete' | 'test' | 'deleteChannel'; id: string; enabled?: boolean }) => {
      if (input.action === 'run') return runResultText((await monitorsApi.run(input.id)).result)
      if (input.action === 'test') { await monitorsApi.testChannel(input.id); return '测试邮件已交给 SMTP 服务，请检查收件箱。' }
      if (input.action === 'toggle') { await monitorsApi.setEnabled(input.id, !!input.enabled); return input.enabled ? '规则已启用，将从下一个周期执行。' : '规则已停用。' }
      if (input.action === 'delete') { await monitorsApi.remove(input.id); return '规则已删除。' }
      await monitorsApi.deleteChannel(input.id); return '通知渠道已删除。'
    },
    onSuccess: async (message) => { setNotice(message); await refresh() },
  })
  const act = (input: Parameters<typeof operation.mutate>[0]) => { setNotice(''); operation.mutate(input) }
  const error = monitors.error ?? channels.error ?? connections.error
  if (monitors.isPending || channels.isPending || connections.isPending) return <p className="muted">正在读取监控与通知配置…</p>
  if (error || !monitors.data || !channels.data || !connections.data) return <div className="card"><p className="error-text" role="alert">读取失败：{describeAuthError(error)}</p><button onClick={() => { void refresh() }}>重新读取</button></div>
  const channelList = channels.data.channels
  const connectionList = connections.data.connections
  return <section>
    <div className="section-head"><div className="help-heading"><h1>监控与通知</h1><HelpTip label="运行规则">定时查询，邮件通知。数据变化与查询失败分别配置。连续两次正常后通知恢复，停机错过的周期不补跑；邮件默认不包含查询数据。</HelpTip></div></div>
    {notice && <p className="status-ok-text" role="status">{notice}</p>}
    {operation.isPending && <p className="muted" role="status">{operation.variables?.action === 'run' ? '正在查询并判断条件…' : operation.variables?.action === 'test' ? '正在连接 SMTP 并发送测试邮件…' : '正在保存…'}</p>}
    {operation.isError && <p className="error-text" role="alert">操作失败：{describeAuthError(operation.error)}</p>}
    <div className="secondary-monitor-layout">
    <section className="secondary-monitor-rules" aria-label="监控规则">
    <div className="section-head"><h2>监控规则</h2><button className="primary" disabled={!channelList.length || !connectionList.length} onClick={() => setEditMonitor('new')}>添加监控规则</button></div>
    {monitors.data.monitors.length === 0 && <div className="card"><p className="muted">暂无监控规则</p></div>}
    <ul className="card-list">{monitors.data.monitors.map((monitor) => <li className="card" key={monitor.id}>
      <div className="card-row"><div><p className="card-title">{monitor.label}</p><p className="muted small">{connectionList.find((c) => c.id === monitor.connection_id)?.label ?? monitor.connection_id} · {monitor.capability_id} · {monitor.mode === 'failure' ? '查询失败告警' : '数据告警'}</p></div><span className={`status ${!monitor.enabled ? 'status-muted' : monitor.runtime.active ? 'status-warn' : 'status-ok'}`}>{!monitor.enabled ? '已停用' : monitor.runtime.active ? '告警中' : '已启用'}</span></div>
      <p><code>{monitor.condition}</code></p><p className="muted small">UTC {monitor.cron} · 冷却 {monitor.cooldown_seconds} 秒 · 下次 {stamp(monitor.next_run_at)}</p>
      <p className={monitor.runtime.delivery === 'failed' || monitor.runtime.last_result === 'error' ? 'error-text' : 'muted'}>{monitorResultText(monitor)}</p>
      <details className="field-help"><summary>执行与通知详情</summary><p className="muted small">上次执行：{stamp(monitor.runtime.last_run_at)}{monitor.runtime.last_status ? ` · 查询状态 ${monitor.runtime.last_status}` : ''} · 连续正常 {monitor.runtime.false_streak}/2</p><p className="muted small">邮件字段：{monitor.email_fields.length ? monitor.email_fields.join('、') : '仅连接与规则'}。个人信息默认隐藏，密钥始终隐藏。</p></details>
      <div className="card-actions"><button onClick={() => setEditMonitor(monitor)}>编辑</button><button disabled={operation.isPending || !monitor.enabled || monitor.runtime.last_result === 'running'} onClick={() => act({ action: 'run', id: monitor.id })}>立即执行</button><button disabled={operation.isPending} onClick={() => act({ action: 'toggle', id: monitor.id, enabled: !monitor.enabled })}>{monitor.enabled ? '停用' : '启用'}</button><button className="danger" disabled={operation.isPending} onClick={() => { if (confirm(`删除规则「${monitor.label}」？`)) act({ action: 'delete', id: monitor.id }) }}>删除</button></div>
    </li>)}</ul>
    </section>
    <aside className="secondary-monitor-channels" aria-label="SMTP 通知渠道">
    <div className="section-head"><h2>SMTP 通知渠道</h2><button onClick={() => setEditChannel('new')}>添加邮件渠道</button></div>
    {channelList.length === 0 && <div className="card"><p className="muted small">添加 SMTP 渠道并发送测试邮件，再创建监控规则。</p></div>}
    <ul className="card-list secondary-channel-list">{channelList.map((channel) => <li className="card" key={channel.id}>
      <div><p className="card-title">{channel.label}</p><p className="muted small">{channel.host}:{channel.port} · {channel.secure ? 'TLS' : 'STARTTLS'} · {channel.has_password ? '已设置密码' : '未设置密码'}</p><p className="muted small">收件人：{channel.to.join('、')}</p></div>
      <div className="card-actions"><button onClick={() => setEditChannel(channel)}>编辑</button><button disabled={operation.isPending} onClick={() => act({ action: 'test', id: channel.id })}>发送测试邮件</button><button className="danger" disabled={operation.isPending} onClick={() => { if (confirm('删除这个邮件渠道？正在使用的渠道会拒绝删除。')) act({ action: 'deleteChannel', id: channel.id }) }}>删除</button></div>
    </li>)}</ul>
    </aside>
    </div>
    {editChannel && <ChannelForm key={typeof editChannel === 'string' ? 'new' : editChannel.id} channel={editChannel === 'new' ? undefined : editChannel} onDone={() => { setEditChannel(null); setNotice('SMTP 配置已保存，密码不会回显。'); void refresh() }} onCancel={() => setEditChannel(null)} />}
    {editMonitor && <MonitorForm key={typeof editMonitor === 'string' ? 'new' : editMonitor.id} monitor={editMonitor === 'new' ? undefined : editMonitor} channels={channelList} connections={connectionList} onDone={() => { setEditMonitor(null); setNotice('规则已保存，将从下一个周期执行。'); void refresh() }} onCancel={() => setEditMonitor(null)} />}
  </section>
}

function ChannelForm({ channel, onDone, onCancel }: { channel: SmtpChannel | undefined; onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState({ label: channel?.label ?? '', host: channel?.host ?? '', port: channel?.port ?? 465, secure: channel?.secure ?? true, user: channel?.user ?? '', from: channel?.from ?? '', to: channel?.to.join(', ') ?? '' })
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const save = useMutation({ mutationFn: async () => {
    const input: SmtpInput = { ...form, to: form.to.split(/[,;\n]/).map((value) => value.trim()).filter(Boolean), ...(clearPassword ? { pass: '' } : password ? { pass: password } : {}) }
    const result = channel ? await monitorsApi.updateChannel(channel.id, input) : await monitorsApi.createChannel(input)
    setPassword(''); return result
  }, onSuccess: onDone })
  const set = <K extends keyof typeof form>(key: K, value: typeof form[K]) => setForm((old) => ({ ...old, [key]: value }))
  function cancel() { if (!save.isPending) { setPassword(''); onCancel() } }
  return <PageDialog title={channel ? '编辑 SMTP 渠道' : '添加 SMTP 渠道'} size="wide" dismissible={!save.isPending} onClose={cancel}><form className="form secondary-dialog-form" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
    <fieldset className="secondary-control-grid" disabled={save.isPending}>
    <label>渠道名称<input required maxLength={100} value={form.label} onChange={(e) => set('label', e.target.value)} /></label>
    <label>SMTP 主机<input required maxLength={253} value={form.host} placeholder="smtp.example.com" onChange={(e) => set('host', e.target.value)} /></label>
    <label>端口<input required type="number" min={1} max={65535} value={form.port} onChange={(e) => set('port', Number(e.target.value))} /></label>
    <div className="field-label"><label className="checkbox-label"><input type="checkbox" checked={form.secure} onChange={(e) => set('secure', e.target.checked)} />直接使用 TLS</label><HelpTip label="SMTP 加密方式">TLS 通常使用 465 端口；取消后由服务器协商 STARTTLS，通常使用 587 端口。不接受未加密投递。</HelpTip></div>
    <label>SMTP 用户<input maxLength={320} autoComplete="username" value={form.user} onChange={(e) => set('user', e.target.value)} /></label>
    <label>{channel?.has_password ? '替换密码（留空保留现有密码）' : 'SMTP 密码'}<input type="password" autoComplete="new-password" value={password} disabled={clearPassword} onChange={(e) => setPassword(e.target.value)} /></label>
    {channel?.has_password && <label className="checkbox-label secondary-full-row"><input type="checkbox" checked={clearPassword} onChange={(e) => { setClearPassword(e.target.checked); setPassword('') }} />清除已保存密码</label>}
    <label>发件地址<input required type="email" value={form.from} onChange={(e) => set('from', e.target.value)} /></label>
    <label>收件地址（多个地址用逗号分隔）<input required value={form.to} onChange={(e) => set('to', e.target.value)} /></label>
    </fieldset>
    {save.isPending && <p role="status">正在保存 SMTP 配置…</p>}{save.isError && <p className="error-text" role="alert">保存失败：{describeAuthError(save.error)}</p>}
    <div className="card-actions"><button className="primary" disabled={save.isPending} type="submit">{save.isPending ? '保存中…' : '保存渠道'}</button><button type="button" disabled={save.isPending} onClick={cancel}>取消</button></div>
  </form></PageDialog>
}

function MonitorForm({ monitor, channels, connections, onDone, onCancel }: { monitor: Monitor | undefined; channels: SmtpChannel[]; connections: Connection[]; onDone: () => void; onCancel: () => void }) {
  const [connectionId, setConnectionId] = useState(monitor?.connection_id ?? connections[0]?.id ?? '')
  const [saving, setSaving] = useState(false)
  const connection = connections.find((c) => c.id === connectionId)
  const capabilities = useQuery({ queryKey: ['capabilities', connection?.connector_id], queryFn: () => api.listCapabilities(connection!.connector_id), enabled: !!connection })
  const [capabilityId, setCapabilityId] = useState(monitor?.capability_id ?? '')
  const selected = capabilities.data?.capabilities.find((c) => c.id === capabilityId)
  return <PageDialog title={monitor ? '编辑监控规则' : '添加监控规则'} size="wide" dismissible={!saving} onClose={onCancel}><div className="secondary-monitor-editor">
    <fieldset disabled={saving} className="secondary-control-grid">
    <label>连接<select value={connectionId} onChange={(e) => { setConnectionId(e.target.value); setCapabilityId('') }}>{connections.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
    <label>查询能力<select value={capabilityId} onChange={(e) => setCapabilityId(e.target.value)}><option value="">请选择只读能力</option>{capabilities.data?.capabilities.filter((c) => c.kind === 'query' && c.effect === 'read').map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
    </fieldset>
    {capabilities.isPending && <p className="muted">正在读取查询能力…</p>}{capabilities.isError && <p className="error-text" role="alert">{describeAuthError(capabilities.error)}</p>}
    {selected ? <RuleFields key={`${connectionId}:${capabilityId}`} capability={selected} connectionId={connectionId} monitor={monitor} channels={channels} onDone={onDone} onCancel={onCancel} onSaving={setSaving} /> : <div className="card-actions"><button type="button" onClick={onCancel}>取消</button></div>}
  </div></PageDialog>
}

function outputFields(schema: Record<string, unknown>, prefix = ''): Array<{ path: string; label: string; pii: boolean }> {
  const properties = schema['properties'] as Record<string, Record<string, unknown>> | undefined
  if (!properties || schema['x-secret'] === true) return []
  return Object.entries(properties).flatMap(([key, field]) => {
    const path = prefix ? `${prefix}.${key}` : key
    if (field['x-secret'] === true) return []
    if (field['type'] === 'object') return outputFields(field, path)
    if (field['type'] === 'array') return []
    return [{ path, label: String(field['title'] ?? path), pii: field['x-sensitivity'] === 'pii' }]
  })
}

function RuleFields({ capability, connectionId, monitor, channels, onDone, onCancel, onSaving }: { capability: Capability; connectionId: string; monitor: Monitor | undefined; channels: SmtpChannel[]; onDone: () => void; onCancel: () => void; onSaving: (saving: boolean) => void }) {
  const sameCapability = monitor?.connection_id === connectionId && monitor.capability_id === capability.id
  const [label, setLabel] = useState(monitor?.label ?? '')
  const [mode, setMode] = useState<MonitorInput['mode']>(monitor?.mode ?? 'data')
  const [cron, setCron] = useState(monitor?.cron ?? '*/15 * * * *')
  const [condition, setCondition] = useState(monitor?.condition ?? '')
  const [channelId, setChannelId] = useState(monitor?.channel_id ?? channels[0]?.id ?? '')
  const [cooldown, setCooldown] = useState(monitor?.cooldown_seconds ?? 3600)
  const [emailFields, setEmailFields] = useState(sameCapability ? monitor?.email_fields ?? [] : [])
  const [enabled, setEnabled] = useState(monitor?.enabled ?? true)
  const fields = inputFields(capability.input)
  const [values, setValues] = useState(() => initialFields(fields, sameCapability ? monitor?.input ?? {} : {}))
  const save = useMutation({ mutationFn: () => {
    const input: MonitorInput = { label, connection_id: connectionId, capability_id: capability.id, cron, timezone: 'UTC', condition,
      mode, channel_id: channelId, cooldown_seconds: cooldown, input: parseFields(fields, values), email_fields: emailFields, enabled }
    return monitor ? monitorsApi.update(monitor.id, input) : monitorsApi.create(input)
  }, onMutate: () => onSaving(true), onSuccess: onDone, onSettled: () => onSaving(false) })
  return <form className="form tight secondary-dialog-form" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
    <fieldset className="secondary-control-grid" disabled={save.isPending}>
    <label>规则名称<input required maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} /></label>
    <label>告警类型<select value={mode} onChange={(e) => { const mode = e.target.value as MonitorInput['mode']; setMode(mode); setCondition(mode === 'failure' ? 'status != ok' : '') }}><option value="data">数据条件</option><option value="failure">查询失败</option></select></label>
    <div className="schema-field"><div className="field-label"><label htmlFor="monitor-condition">条件</label><HelpTip label="告警条件说明">{mode === 'failure' ? '查询失败规则只判断 status，例如 status != ok。' : '数据规则判断字段或 state(字段)，支持 and / or / !。查询失败时不会误报数据告警，也不会计入恢复。'}</HelpTip></div><input id="monitor-condition" required maxLength={1000} value={condition} placeholder={mode === 'failure' ? 'status != ok' : 'quota < 5 或 state(quota) == unknown'} onChange={(e) => setCondition(e.target.value)} /></div>
    <div className="schema-field"><div className="field-label"><label htmlFor="monitor-cron">执行周期（UTC，五字段 cron）</label><HelpTip label="执行周期说明">分 时 日 月 星期。例如 */15 * * * * 表示每 15 分钟，0 0 * * * 表示 UTC 每日零点。最多每分钟一次，错过周期不会补跑。</HelpTip></div><input id="monitor-cron" required maxLength={120} value={cron} onChange={(e) => setCron(e.target.value)} /></div>
    <label>冷却时间（秒）<input type="number" required min={60} max={2592000} value={cooldown} onChange={(e) => setCooldown(Number(e.target.value))} /></label>
    {fields.length > 0 && <><p className="card-title secondary-full-row">查询参数</p><SchemaFields fields={fields} values={values} onChange={setValues} disabled={save.isPending} /></>}
    <label>通知渠道<select value={channelId} onChange={(e) => setChannelId(e.target.value)}>{channels.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
    <fieldset className="secondary-email-fields secondary-full-row"><legend>允许带入邮件的数据字段（默认不勾选）</legend>{outputFields(capability.output).map((field) => <label key={field.path} className="checkbox-label"><input type="checkbox" disabled={field.pii} checked={emailFields.includes(field.path)} onChange={(e) => setEmailFields((old) => e.target.checked ? [...old, field.path] : old.filter((value) => value !== field.path))} />{field.label} <code>{field.path}</code>{field.pii ? '（个人信息，定时通知隐藏）' : ''}</label>)}</fieldset>
    <p className="muted small">只会发送勾选字段。个人信息按定时任务策略隐藏，秘密字段始终隐藏；连续两次条件为假后发恢复通知。</p>
    <label style={{ display: 'flex', gap: 8 }}><input style={{ width: 'auto' }} type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />启用规则</label>
    </fieldset>
    {save.isPending && <p role="status">正在保存规则…</p>}{save.isError && <p className="error-text" role="alert">保存失败：{describeAuthError(save.error)}</p>}
    <div className="card-actions"><button type="submit" className="primary" disabled={save.isPending}>{save.isPending ? '保存中…' : '保存规则'}</button><button type="button" disabled={save.isPending} onClick={onCancel}>取消</button></div>
  </form>
}
