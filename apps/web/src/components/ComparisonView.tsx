import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ComparisonView } from '@owngate/core'
import { api, type Capability, type Connection } from '../lib/api'
import { comparisonsApi, comparisonValue, type ComparisonRow } from '../lib/comparisons-api'
import { describeAuthError } from '../lib/http'
import { initialFields, inputFields, parseFields } from '../lib/schema-fields'
import { PageDialog } from './PageDialog'
import { HelpTip } from './HelpTip'
import { SchemaFields } from './SchemaFields'
import { QueryResult } from './QueryResult'
import { Icon } from './Icon'
import './ComparisonView.css'

/** One renderer for every connector's compiled comparison declaration. */
export function ConnectionComparison({ connection, connections, view, source }: {
  connection: Connection
  connections: Connection[]
  view: ComparisonView
  source: Capability
}) {
  const qc = useQueryClient()
  const opener = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const fields = inputFields(source.input)
  const [values, setValues] = useState(() => initialFields(fields))
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const savingAny = Object.values(saving).some(Boolean)
  const queryKey = ['comparison-links', connection.id, view.id]
  const links = useQuery({ queryKey, queryFn: () => comparisonsApi.links(connection.id, view.id), enabled: open })
  const otherConnections = connections.filter(item => item.id !== connection.id)
  const targetCapabilities = useQueries({ queries: otherConnections.map(item => ({
    queryKey: ['capabilities', item.connector_id, item.id, item.config],
    queryFn: () => api.listCapabilities(item.connector_id, item.id), enabled: open,
  })) })
  const targets = otherConnections.filter((item, index) => !item.paused && targetCapabilities[index]?.data?.capabilities.some(cap => cap.id === view.target.capability && cap.kind === 'query' && cap.effect === 'read' && !['disabled', 'unsupported'].includes(item.capability_states[cap.id]?.status ?? cap.support.status)))
  const run = useMutation({ mutationFn: () => comparisonsApi.run(connection.id, view.id, parseFields(fields, values)), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['connections'] }) } })
  const busy = run.isPending || savingAny

  function changed() {
    void qc.invalidateQueries({ queryKey })
    void qc.invalidateQueries({ queryKey: ['connections'] })
    run.reset()
    setNotice('映射已保存，请重新读取并比较。')
  }

  return <>
    <button ref={opener} type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}><Icon name="compare" />{view.title}</button>
    {open && <PageDialog title={view.title} size="wide" onClose={() => setOpen(false)} dismissible={!savingAny} returnFocusRef={opener}>
      <div className="comparison-workspace" data-comparison-view-id={view.id}>
        <form className="form comparison-form" aria-label={`${view.title}查询`} onSubmit={event => { event.preventDefault(); if (!busy && !connection.paused) { setNotice(''); run.mutate() } }}>
          {fields.length > 0 && <div className="comparison-fields"><SchemaFields fields={fields} values={values} onChange={setValues} disabled={busy || connection.paused === true} /></div>}
          <div className="card-actions"><button className="primary" type="submit" disabled={busy || connection.paused}><Icon name="compare" />{run.isPending ? '正在读取并比较…' : '读取并比较'}</button><HelpTip label={`${view.title}说明`}>{view.description && <p>{view.description}</p>}<p>手动选择独立授权的对照连接。只有两端数值、时间和单位足够明确时才计算差额，源记录的凭据不会用于其他连接。</p><p>每次最多比较 100 条，更多记录请通过查询参数分别读取。</p></HelpTip></div>
        </form>
        {connection.paused && <p className="muted small">连接已暂停，恢复后才能查询。</p>}
        {notice && <p className="status-ok-text small" role="status">{notice}</p>}
        {links.isError && <p className="error-text" role="alert">读取映射失败：{describeAuthError(links.error)}</p>}
        {targetCapabilities.some(query => query.isError) && <p className="error-text small" role="alert">部分连接的能力读取失败，暂时无法选为对照连接。</p>}
        {run.isError && <p className="error-text" role="alert">比较失败：{describeAuthError(run.error)}</p>}
        {run.data && <>
          <p className="muted small" role="status">{run.data.outcome === 'error' ? '源查询失败，未进行比较。' : run.data.rows.length === 0 ? '本次没有可比较的记录。' : run.data.outcome === 'success' ? '本次各项均可比较。' : '存在未关联、单位未确认或查询失败的项目。'}</p>
          <details className="comparison-source" open={run.data.outcome === 'error'}><summary>源查询结果</summary><QueryResult envelope={run.data.source} capability={source} /></details>
          <ul className="card-list comparison-rows">{run.data.rows.map(row => {
            const targetId = links.data?.links.find(link => link.item_id === row.item_id)?.target_connection_id ?? row.target_connection_id ?? ''
            return <ComparisonItem key={`${row.item_id}:${targetId}`} connectionId={connection.id} viewId={view.id} row={row} targetId={targetId} targets={targets}
              disabled={busy || links.isPending || links.isError || connection.paused === true}
              onSaved={changed} onBusy={(id, pending) => setSaving(current => current[id] === pending ? current : { ...current, [id]: pending })} />
          })}</ul>
        </>}
      </div>
    </PageDialog>}
  </>
}

function ComparisonItem({ connectionId, viewId, row, targetId, targets, disabled, onSaved, onBusy }: {
  connectionId: string
  viewId: string
  row: ComparisonRow
  targetId: string
  targets: Connection[]
  disabled: boolean
  onSaved: () => void
  onBusy: (id: string, busy: boolean) => void
}) {
  const [selected, setSelected] = useState(targetId)
  const busyCallback = useRef(onBusy)
  busyCallback.current = onBusy
  const save = useMutation({ mutationFn: async () => {
    if (selected) await comparisonsApi.setLink(connectionId, viewId, row.item_id, selected)
    else await comparisonsApi.deleteLink(connectionId, viewId, row.item_id)
  }, onSuccess: onSaved })
  useEffect(() => {
    busyCallback.current(row.item_id, save.isPending)
    return () => busyCallback.current(row.item_id, false)
  }, [row.item_id, save.isPending])
  return <li className="card comparison-item" data-comparison-item-id={row.item_id}>
    <h3 className="card-title">{row.label}</h3>
    <dl className="comparison-values"><div><dt>源数值</dt><dd>{comparisonValue(row.source_value.value, row.source_value.unit)}</dd></div><div><dt>源更新时间</dt><dd>{row.source_value.updated_at ? new Date(row.source_value.updated_at).toLocaleString('zh-CN') : '未知'}</dd></div>{row.comparison.status === 'comparable' && <div><dt>源值减对照值</dt><dd>{comparisonValue(row.comparison.difference ?? null, row.comparison.unit ?? '')}</dd></div>}</dl>
    <p className="muted small">{row.comparison.reason}</p>
    {row.target && <details><summary>对照查询结果</summary><QueryResult envelope={row.target} /></details>}
    <form className="form comparison-link-form" onSubmit={event => { event.preventDefault(); if (!disabled && !save.isPending) save.mutate() }}>
      <label>对照连接<select value={selected} disabled={disabled || save.isPending} onChange={event => setSelected(event.target.value)}><option value="">不关联</option>{targetId && !targets.some(item => item.id === targetId) && <option value={targetId}>已关联连接（当前不可用）</option>}{targets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <button type="submit" disabled={disabled || save.isPending}>{save.isPending ? '正在确认并保存…' : '保存映射'}</button>
    </form>
    {save.isError && <p className="error-text" role="alert">映射未保存：{describeAuthError(save.error)}</p>}
  </li>
}
