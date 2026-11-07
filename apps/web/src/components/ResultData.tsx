import { useMemo, useState } from 'react'
import type { Envelope, ResultPresentation } from '../lib/api'
import { buildResultView, type CollectionNode, type FeedNode, type ObjectNode, type ResultNode, type ValueNode } from '../lib/result-presentation'
import { HelpTip } from './HelpTip'
import './ResultData.css'

interface ResultDataProps { envelope: Envelope; schema?: Record<string, unknown>; presentation?: ResultPresentation }

export function ResultData({ envelope, schema, presentation }: ResultDataProps) {
  const [preview, setPreview] = useState<{ envelope: Envelope; rows: Record<string, number> }>(() => ({ envelope, rows: {} }))
  const visibleRows = preview.envelope === envelope ? preview.rows : {}
  const view = useMemo(() => buildResultView(envelope, schema, presentation, { visibleRows }), [envelope, schema, presentation, visibleRows])
  if (!view.nodes.length) return null
  function resize(collection: CollectionNode, expand: boolean) {
    setPreview(current => ({ envelope, rows: { ...(current.envelope === envelope ? current.rows : {}), [collection.path]: expand ? collection.shown + collection.step : collection.step } }))
  }
  return <div className="result-data" data-presentation={view.type}>
    <Nodes nodes={view.nodes} resize={resize} />
  </div>
}

type Resize = (collection: CollectionNode, expand: boolean) => void
function FieldLabel({ node }: { node: { label: string; description?: string; reason?: string } }) {
  const help = [node.description, node.reason].filter(Boolean).join(' ')
  return <span className="result-data-label">{node.label}{help && <HelpTip label={`${node.label}说明`}>{help}</HelpTip>}</span>
}

function TextValue({ text, textKind = '文本' }: { text: string; textKind?: '文本' | '正文' }) {
  const [preview, setPreview] = useState({ text, expanded: false })
  const expanded = preview.text === text && preview.expanded
  if (text.length <= 180) return <>{text}</>
  return <span className="result-long-text"><span>{expanded ? text : `${text.slice(0, 180)}…`}</span><button type="button" className="link result-expand-text" onClick={() => setPreview({ text, expanded: !expanded })}>{expanded ? `收起${textKind}` : `展开${textKind}`}</button></span>
}

function ValueContent({ node, textKind, hideCountUnit = false }: { node: ValueNode; textKind?: '文本' | '正文'; hideCountUnit?: boolean }) {
  return <span className={`result-data-value${node.prominent ? ' result-data-value-prominent' : ''}${node.badge ? ' result-data-badge' : ''}`} data-value-status={node.status}>
    {node.href ? <a href={node.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" title={node.text.length > 180 ? node.text : undefined}>{node.text.length > 180 ? `${node.text.slice(0, 180)}…` : node.text}</a> : <TextValue text={node.text} {...(textKind ? { textKind } : {})} />}
    {node.unit && !(hideCountUnit && node.unit === 'count') && <span className="result-data-unit">{node.unit}</span>}
    {node.status === 'expired' && <span className="result-value-state">已过期</span>}
    {node.truncated && <span className="muted small">完整文本见详细数据</span>}
  </span>
}

function Nodes({ nodes, resize }: { nodes: ResultNode[]; resize: Resize }) {
  const fields = nodes.filter((node): node is ValueNode => node.kind === 'value')
  const structures = nodes.filter(node => node.kind !== 'value')
  return <>
    {fields.length > 0 && <dl className="result-data-fields" aria-label="查询摘要">{fields.map((field, index) => <div className="result-stat-field" key={`${field.path}:${index}`}><dt><FieldLabel node={field} /></dt><dd><ValueContent node={field} /></dd></div>)}</dl>}
    {structures.map((node, index) => <Structure key={`${node.path}:${index}`} node={node} resize={resize} />)}
  </>
}

function ObjectValue({ node, resize, heading = true }: { node: ObjectNode; resize: Resize; heading?: boolean }) {
  return <section className="result-data-object" data-object-path={node.path}>
    {heading && <h4><FieldLabel node={node} /></h4>}
    {node.children.length ? <Nodes nodes={node.children} resize={resize} /> : <p className="muted small">本次返回空对象</p>}
  </section>
}

function Cell({ node, resize }: { node: ResultNode; resize: Resize }) {
  if (node.kind === 'value') return <ValueContent node={node} />
  if (node.kind === 'object') return <ObjectValue node={node} resize={resize} heading={false} />
  return <Structure node={node} resize={resize} />
}

function FeedItem({ node }: { node: FeedNode }) {
  const hasTitle = node.title.status !== 'missing' && node.title.status !== 'null'
  const hasBody = node.body.status !== 'missing' && node.body.status !== 'null'
  const knownMetrics = node.metrics.filter(field => field.numeric && ['ok', 'expired'].includes(field.status))
  const hidden = node.metrics.filter(field => field.status === 'redacted').length
  const unavailable = node.metrics.filter(field => field.status === 'unavailable').length
  const unknown = node.metrics.length - knownMetrics.length - hidden - unavailable
  return <article className="result-feed-item" data-feed-path={node.path}>
    <div className="result-feed-meta muted small"><span>{node.author.status === 'missing' || node.author.status === 'null' ? '作者未知' : <ValueContent node={node.author} />}</span><span>{node.date.status === 'missing' || node.date.status === 'null' ? '发布时间未知' : <ValueContent node={node.date} />}</span></div>
    {hasTitle && <strong className="result-feed-title"><ValueContent node={node.title} /></strong>}
    {hasBody && <div className="result-feed-body"><ValueContent node={node.body} textKind="正文" /></div>}
    <div className="result-feed-metrics muted small">{knownMetrics.map(field => <span key={field.path}>{field.label}：<ValueContent node={field} hideCountUnit /></span>)}{unknown > 0 && <span>{unknown} 项指标未知</span>}{hidden > 0 && <span>{hidden} 项指标已隐藏</span>}{unavailable > 0 && <span>{unavailable} 项指标暂不可用</span>}</div>
    {node.link.href && <a className="result-feed-link" href={node.link.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">查看原文 ↗</a>}
  </article>
}

function Collection({ node, resize }: { node: CollectionNode; resize: Resize }) {
  return <section className={`result-collection result-collection-${node.mode}`} data-collection-path={node.path}>
    <div className="result-collection-heading"><h4><FieldLabel node={node} /></h4><span className="muted small">{node.total} 项{node.shown > 0 && node.shown < node.total ? ` · 已显示 ${node.shown} 项` : ''}</span></div>
    {node.total === 0 ? <p className="muted small result-collection-empty">{node.emptyText}</p> : node.mode === 'table' ? <div className="result-table-wrap"><table className="result-data-table" aria-label={node.label === '结果' ? '查询记录' : node.label}>
      <thead><tr>{node.columns.map((column, index) => <th key={`${column.key}:${index}`} scope="col">{column.label}</th>)}</tr></thead>
      <tbody>{node.rows.map((row, index) => <tr className="result-record-row" key={`${row.path}:${index}`}>{row.kind === 'object' ? row.children.map((cell, column) => <td data-label={node.columns[column]?.label} key={`${cell.path}:${column}`}><Cell node={cell} resize={resize} /></td>) : <td colSpan={node.columns.length}><Cell node={row} resize={resize} /></td>}</tr>)}</tbody>
    </table></div> : node.mode === 'feed' ? <div className="result-feed-list">{node.rows.map((row, index) => row.kind === 'feed' ? <FeedItem node={row} key={row.path} /> : <div key={`${row.path}:${index}`}><Cell node={row} resize={resize} /></div>)}</div>
      : <ul className="result-data-list">{node.rows.map((row, index) => <li className="result-list-item" key={`${row.path}:${index}`}>{row.kind === 'object' ? <ObjectValue node={row} resize={resize} heading={false} /> : <Cell node={row} resize={resize} />}</li>)}</ul>}
    {(node.canExpand || node.canCollapse) && <div className="result-collection-actions">{node.canExpand && <button className="link" type="button" onClick={() => resize(node, true)}>显示更多</button>}{node.canCollapse && <button className="link" type="button" onClick={() => resize(node, false)}>收起</button>}</div>}
    {!node.canExpand && node.shown < node.total && <p className="muted small">其余内容见详细数据</p>}
  </section>
}

function Structure({ node, resize }: { node: ResultNode; resize: Resize }) {
  if (node.kind === 'object') return <ObjectValue node={node} resize={resize} />
  if (node.kind === 'collection') return <Collection node={node} resize={resize} />
  if (node.kind === 'feed') return <FeedItem node={node} />
  if (node.kind === 'value') return <ValueContent node={node} />
  return <p className="muted small result-data-limit">{node.label} · 更多内容见详细数据</p>
}
