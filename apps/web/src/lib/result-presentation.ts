import type { Envelope, PresentationField, ResultPresentation } from './api'
import { resultFields } from './query-result'

type Schema = Record<string, unknown>
type DataPath = string[]
export type ValueStatus = 'ok' | 'unknown' | 'unavailable' | 'redacted' | 'expired' | 'missing' | 'null' | 'invalid'

export interface ValueNode {
  kind: 'value'
  path: string
  label: string
  text: string
  unit: string
  status: ValueStatus
  prominent: boolean
  numeric: boolean
  badge: boolean
  href?: string
  description?: string
  reason?: string
  truncated?: boolean
}

export interface ObjectNode {
  kind: 'object'
  path: string
  label: string
  children: ResultNode[]
  description?: string
}

export interface FeedNode {
  kind: 'feed'
  path: string
  author: ValueNode
  title: ValueNode
  body: ValueNode
  date: ValueNode
  link: ValueNode
  metrics: ValueNode[]
}

export interface CollectionNode {
  kind: 'collection'
  path: string
  label: string
  mode: 'table' | 'list' | 'feed'
  rows: ResultNode[]
  columns: { key: string; label: string }[]
  total: number
  shown: number
  step: number
  canExpand: boolean
  canCollapse: boolean
  emptyText: string
  description?: string
}

export interface LimitNode { kind: 'limit'; path: string; label: string }
export type ResultNode = ValueNode | ObjectNode | CollectionNode | FeedNode | LimitNode
export interface ResultView { type: ResultPresentation['type']; nodes: ResultNode[] }
export interface ViewOptions { visibleRows?: Record<string, number> }

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const MASKED_STATES = new Set(['unknown', 'unavailable', 'redacted'])
const MAX_DEPTH = 5
const MAX_NODES = 400
export const MAX_VISIBLE_ROWS = 50
const MAX_FIELDS = 12
const MAX_COLUMNS = 6
const MAX_TEXT = 4000
const UNITS: Record<string, string> = {
  site_balance: '单位待确认', requests: '次请求', records: '条', channels: '个渠道',
  requests_per_minute: '次/分钟', tokens_per_minute: 'tokens/分钟', ratio: '倍',
}
const STATE_TEXT: Partial<Record<ValueStatus, string>> = {
  unknown: '未知', unavailable: '暂不可用', redacted: '已隐藏', missing: '未提供', null: '无值', invalid: '无效数值',
}

export function objectValue(value: unknown): Schema | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Schema : undefined
}
function own(value: unknown, key: string): unknown {
  return !FORBIDDEN_KEYS.has(key) && value !== null && typeof value === 'object' && Object.hasOwn(value, key)
    ? (value as Schema)[key] : undefined
}
function bounded(value: unknown, length: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, length) : undefined
}
function schemaObject(value: unknown): Schema { return objectValue(value) ?? {} }
function isRecordSchema(schema: Schema): boolean { return schema['type'] === 'object' || objectValue(schema['properties']) !== undefined }
function isArraySchema(schema: Schema): boolean { return schema['type'] === 'array' || Array.isArray(schema['type']) && schema['type'].includes('array') }
function pathKey(path: DataPath): string { return path.join('.') }
function schemaChild(schema: Schema, key: string): Schema { return schemaObject(own(schema['properties'], key)) }
function schemaItem(schema: Schema): Schema { return schemaObject(schema['items']) }

/** Deliberately not JSONPath: imported metadata cannot evaluate expressions. */
export function presentationPath(path: string): string[] | undefined {
  if (path === '$') return []
  if (typeof path !== 'string' || path.length > 128) return undefined
  const value = path.startsWith('$.') ? path.slice(2) : path
  const parts = value.split('.')
  if (parts.length > 8 || parts.some(part => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(part) || FORBIDDEN_KEYS.has(part))) return undefined
  return parts
}

/** Navigation is always a user action; no remote image or URL is fetched. */
export function safeResultLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_TEXT || /\[REDACTED\]/i.test(value)) return undefined
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}

interface Context {
  envelope: Envelope
  schema: Schema
  metas: Map<string, Schema>
  legacyLabels: Map<string, string>
  legacyProminent: Set<string>
  defaultStep: number
  visible: Record<string, number>
  remaining: number
}

function valueAt(root: unknown, path: DataPath): unknown {
  let value = root
  for (const part of path) value = own(value, part)
  return value
}
function schemaAt(root: Schema, path: DataPath): Schema {
  let schema = root
  for (const part of path) schema = /^\d+$/.test(part) && (isArraySchema(schema) || schema['items'] !== undefined) ? schemaItem(schema) : schemaChild(schema, part)
  return schema
}
function metaAt(context: Context, path: DataPath): Schema { return context.metas.get(pathKey(path)) ?? {} }

function effectiveState(context: Context, path: DataPath): { status: ValueStatus; reason?: string } {
  let expired = false
  for (let length = 0; length <= path.length; length++) {
    const prefix = path.slice(0, length), meta = metaAt(context, prefix), schema = schemaAt(context.schema, prefix)
    const status = meta['status']
    const value = valueAt(context.envelope.data, prefix)
    if (schema['x-secret'] === true || schema['writeOnly'] === true || value === '[REDACTED]' || status === 'redacted') {
      return { status: 'redacted', ...(bounded(meta['reason'], 500) ? { reason: bounded(meta['reason'], 500)! } : {}) }
    }
    if (status === 'unknown' || status === 'unavailable') return { status, ...(bounded(meta['reason'], 500) ? { reason: bounded(meta['reason'], 500)! } : {}) }
    if (status === 'expired') expired = true
  }
  return { status: expired ? 'expired' : 'ok' }
}

function label(context: Context, schema: Schema, path: DataPath, override?: string): string {
  return bounded(override, 80) ?? bounded(schema['title'], 80)
    ?? (path.length === 1 ? context.legacyLabels.get(path[0]!) : undefined)
    ?? bounded(path.at(-1), 80) ?? '结果'
}
function description(schema: Schema): string | undefined { return bounded(schema['description'], 500) }

function datetime(value: unknown, unit: string, format: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  if (typeof value === 'number' && !['unix_seconds', 'unix_milliseconds', 'milliseconds'].includes(unit)) return undefined
  const date = new Date(typeof value === 'number' && unit === 'unix_seconds' ? value * 1000 : value)
  if (!Number.isFinite(date.getTime())) return undefined
  return format === 'date' ? date.toLocaleDateString('zh-CN') : date.toLocaleString('zh-CN', { hour12: false })
}

function valueNode(context: Context, value: unknown, schema: Schema, path: DataPath, binding?: PresentationField): ValueNode {
  const state = effectiveState(context, path)
  let status = state.status
  const meta = metaAt(context, path)
  const rawUnit = typeof meta['unit'] === 'string' ? meta['unit'] : typeof schema['x-unit'] === 'string' ? schema['x-unit'] : ''
  const schemaFormat = schema['format']
  const format = binding?.format ?? (schemaFormat === 'uri' || schemaFormat === 'url' ? 'link'
    : ['date', 'date-time'].includes(String(schemaFormat)) || ['unix_seconds', 'unix_milliseconds'].includes(rawUnit) ? 'datetime' : 'text')
  let text: string
  let href: string | undefined
  if (MASKED_STATES.has(status)) text = STATE_TEXT[status]!
  else if (value === undefined) { status = 'missing'; text = STATE_TEXT.missing! }
  else if (value === null) { status = 'null'; text = STATE_TEXT.null! }
  else if (typeof value === 'number') {
    if (!Number.isFinite(value)) { status = 'invalid'; text = STATE_TEXT.invalid! }
    else text = format === 'datetime' ? datetime(value, rawUnit, schemaFormat) ?? String(value) : String(value)
  } else if (typeof value === 'boolean') text = value ? '是' : '否'
  else if (typeof value === 'string') {
    text = value === '' ? '空文本' : format === 'datetime' ? datetime(value, rawUnit, schemaFormat) ?? value : value
    if (format === 'link') href = safeResultLink(value)
  } else if (Array.isArray(value)) text = `${value.length} 项`
  else text = '查看下方内容'
  const unit = !MASKED_STATES.has(status) && !['missing', 'null', 'invalid'].includes(status) && format !== 'datetime'
    ? (Object.hasOwn(UNITS, rawUnit) ? UNITS[rawUnit]! : rawUnit) : ''
  const help = description(schema)
  return {
    kind: 'value', path: pathKey(path), label: label(context, schema, path, binding?.label), text: text.slice(0, MAX_TEXT), unit, status,
    prominent: typeof value === 'number' && (status === 'ok' || status === 'expired') && (binding?.prominent
      ?? (schema['x-sensitivity'] === 'financial' || (Object.keys(schema).length === 0 && context.legacyProminent.has(pathKey(path))))),
    numeric: typeof value === 'number' && Number.isFinite(value), badge: format === 'badge',
    ...(href ? { href } : {}), ...(help ? { description: help } : {}), ...(state.reason ? { reason: state.reason } : {}),
    ...(text.length > MAX_TEXT ? { truncated: true } : {}),
  }
}

function keysFor(value: unknown, schema: Schema): string[] {
  const properties = schemaObject(schema['properties'])
  const actual = objectValue(value) ?? {}
  return [...new Set([...Object.keys(properties), ...Object.keys(actual)])].filter(key => !FORBIDDEN_KEYS.has(key))
}

function bindingNode(context: Context, value: unknown, schema: Schema, base: DataPath, binding: PresentationField, depth: number, internalPath?: DataPath): ResultNode {
  const parts = internalPath ?? presentationPath(binding.path)
  if (!parts) return { kind: 'limit', path: pathKey(base), label: bounded(binding.label, 80) ?? '字段' }
  return node(context, valueAt(value, parts), schemaAt(schema, parts), [...base, ...parts], depth, binding)
}

function objectChildren(context: Context, value: unknown, schema: Schema, path: DataPath, depth: number, bindings?: PresentationField[]): ResultNode[] {
  if (bindings?.length) {
    const children: ResultNode[] = []
    for (const binding of bindings.slice(0, MAX_FIELDS)) {
      if (context.remaining <= 0) break
      children.push(bindingNode(context, value, schema, path, binding, depth + 1))
    }
    return children
  }
  const keys = keysFor(value, schema)
  const children: ResultNode[] = []
  for (const key of keys.slice(0, MAX_FIELDS)) {
    if (context.remaining <= 0) break
    children.push(node(context, own(value, key), schemaChild(schema, key), [...path, key], depth + 1))
  }
  if (keys.length > MAX_FIELDS && context.remaining > 0) {
    context.remaining--
    children.push({ kind: 'limit', path: pathKey(path), label: '更多字段' })
  }
  return children
}

interface ColumnDefinition { binding: PresentationField; schema: Schema; parts: DataPath }
function autoColumns(rows: unknown[], itemSchema: Schema): ColumnDefinition[] {
  const sample = rows.find(row => objectValue(row) !== undefined)
  const columns: ColumnDefinition[] = []
  function visit(value: unknown, schema: Schema, base: DataPath, titles: string[], depth: number) {
    for (const key of keysFor(value, schema)) {
      if (columns.length >= MAX_COLUMNS) return
      const child = schemaChild(schema, key), childValue = own(value, key), path = [...base, key]
      if (child['x-secret'] === true || child['writeOnly'] === true) continue
      const title = bounded(child['title'], 80) ?? key
      if (depth < 2 && (isRecordSchema(child) || objectValue(childValue))) visit(childValue, child, path, [...titles, title], depth + 1)
      else columns.push({ binding: { path: path.join('.'), label: [...titles, title].join(' · ').slice(0, 80) }, schema: child, parts: path })
    }
  }
  if (sample || isRecordSchema(itemSchema)) visit(sample, itemSchema, [], [], 0)
  if (!columns.length) columns.push({ binding: { path: '$', label: bounded(itemSchema['title'], 80) ?? '内容' }, schema: itemSchema, parts: [] })
  return columns
}

function feedNode(context: Context, value: unknown, schema: Schema, path: DataPath): FeedNode | ValueNode {
  if (MASKED_STATES.has(effectiveState(context, path).status) || !objectValue(value)) return valueNode(context, value, schema, path)
  function field(relative: string, title: string, format?: PresentationField['format']): ValueNode {
    const parts = relative.split('.')
    return valueNode(context, valueAt(value, parts), schemaAt(schema, parts), [...path, ...parts], { path: relative, label: title, ...(format ? { format } : {}) })
  }
  return {
    kind: 'feed', path: pathKey(path), author: field('author.name', '作者'), title: field('title', '标题'), body: field('text', '正文'),
    date: field('published_at', '发布时间', 'datetime'), link: field('url', '原文', 'link'),
    metrics: [['likes', '赞'], ['comments', '评论'], ['shares', '分享'], ['views', '浏览']].map(([key, title]) => field(`metrics.${key}`, title!)),
  }
}

function collectionNode(context: Context, value: unknown[], schema: Schema, path: DataPath, depth: number, presentation?: ResultPresentation): CollectionNode {
  const itemSchema = schemaItem(schema)
  const step = Math.min(20, Math.max(1, Math.floor(presentation?.max_rows ?? context.defaultStep)))
  const requested = context.visible[pathKey(path)] ?? step
  const visible = Math.min(value.length, MAX_VISIBLE_ROWS, Math.max(step, Math.floor(requested)))
  const mode = presentation?.type === 'feed' ? 'feed' : presentation?.type === 'list' ? 'list'
    : presentation?.type === 'table' || value.some((entry, index) => objectValue(entry) !== undefined && !MASKED_STATES.has(effectiveState(context, [...path, String(index)]).status)) || isRecordSchema(itemSchema) ? 'table' : 'list'
  const columns = mode === 'table' ? presentation?.columns?.length
    ? presentation.columns.slice(0, MAX_FIELDS).map(binding => ({ binding, schema: schemaAt(itemSchema, presentationPath(binding.path) ?? []), parts: presentationPath(binding.path) ?? [] }))
    : autoColumns(value.filter((_, index) => !MASKED_STATES.has(effectiveState(context, [...path, String(index)]).status)), itemSchema) : []
  const rows: ResultNode[] = []
  let budgetExhausted = false
  for (let index = 0; index < visible && context.remaining > 0; index++) {
    const rowPath = [...path, String(index)], item = value[index]
    if (mode === 'feed') {
      const cost = MASKED_STATES.has(effectiveState(context, rowPath).status) || !objectValue(item) ? 1 : 10
      if (context.remaining < cost) { budgetExhausted = true; break }
      context.remaining -= cost
      rows.push(feedNode(context, item, itemSchema, rowPath)); continue
    }
    if (mode === 'table') {
      if (!objectValue(item) && !columns.some(column => column.parts.length === 0)) {
        rows.push(node(context, item, itemSchema, rowPath, depth + 1)); continue
      }
      context.remaining--
      const masked = MASKED_STATES.has(effectiveState(context, rowPath).status)
      const children: ResultNode[] = []
      for (const { binding, parts } of columns) {
        if (context.remaining <= 0) break
        if (masked) { context.remaining--; children.push(valueNode(context, undefined, {}, rowPath, binding)) }
        else children.push(bindingNode(context, item, itemSchema, rowPath, binding, depth + 1, parts))
      }
      rows.push({ kind: 'object', path: pathKey(rowPath), label: `记录 ${index + 1}`,
        children })
      continue
    }
    if (presentation?.fields?.length) {
      context.remaining--
      rows.push({ kind: 'object', path: pathKey(rowPath), label: `记录 ${index + 1}`,
        children: objectChildren(context, item, itemSchema, rowPath, depth + 1, presentation.fields) })
    }
    else rows.push(node(context, item, itemSchema, rowPath, depth + 1))
  }
  const help = description(schema)
  return { kind: 'collection', path: pathKey(path), label: label(context, schema, path), mode, rows,
    columns: columns.map(({ binding, schema: columnSchema, parts }) => ({ key: binding.path, label: binding.label ?? label(context, columnSchema, parts) })),
    total: value.length, shown: rows.length, step, canExpand: !budgetExhausted && rows.length < Math.min(value.length, MAX_VISIBLE_ROWS) && context.remaining > 0,
    canCollapse: rows.length > step, emptyText: context.envelope.outcome === 'partial' ? '本次未返回条目' : '本次返回 0 项',
    ...(help ? { description: help } : {}),
  }
}

function node(context: Context, value: unknown, schema: Schema, path: DataPath, depth: number, binding?: PresentationField): ResultNode {
  if (context.remaining-- <= 0 || depth > MAX_DEPTH) return { kind: 'limit', path: pathKey(path), label: label(context, schema, path, binding?.label) }
  if (MASKED_STATES.has(effectiveState(context, path).status) || value === null || value === undefined || typeof value !== 'object') return valueNode(context, value, schema, path, binding)
  if (Array.isArray(value)) return collectionNode(context, value, schema, path, depth)
  const help = description(schema)
  return { kind: 'object', path: pathKey(path), label: label(context, schema, path, binding?.label), children: objectChildren(context, value, schema, path, depth), ...(help ? { description: help } : {}) }
}

/** Only authorized envelope values enter the model. Schema describes their
 * presentation; it is never a source of defaults, examples or hidden data. */
export function buildResultView(envelope: Envelope, schema: Schema = {}, presentation?: ResultPresentation, options: ViewOptions = {}): ResultView {
  const type = presentation?.type ?? 'auto'
  if (envelope.outcome === 'error' || type === 'json') return { type, nodes: [] }
  const metas = new Map<string, Schema>()
  for (const [key, raw] of Object.entries(envelope.fields).slice(0, 10_000)) {
    const meta = objectValue(raw)
    if (meta) metas.set(key.replace(/\[(\d+)\]/g, '.$1').replace(/^\$\.?/, ''), meta)
  }
  const legacy = resultFields(envelope)
  const context: Context = { envelope, schema, metas, legacyLabels: new Map(legacy.map(field => [field.key, field.label])),
    legacyProminent: new Set(legacy.filter(field => field.prominent).map(field => field.key)), defaultStep: presentation?.max_rows ?? 5,
    visible: options.visibleRows ?? {}, remaining: MAX_NODES }
  const rootState = effectiveState(context, [])
  if (MASKED_STATES.has(rootState.status) || envelope.data === undefined || envelope.data === null) return { type, nodes: [valueNode(context, envelope.data, schema, [])] }
  if (['table', 'list', 'feed'].includes(type)) {
    const path = presentationPath(presentation?.items ?? '$')
    if (path) {
      const value = valueAt(envelope.data, path), selectedSchema = schemaAt(schema, path)
      if (!MASKED_STATES.has(effectiveState(context, path).status) && Array.isArray(value)) {
        context.remaining--
        return { type, nodes: [collectionNode(context, value, selectedSchema, path, 0, presentation)] }
      }
      return { type, nodes: [valueNode(context, value, selectedSchema, path)] }
    }
  }
  if (type === 'stats' && presentation?.fields?.length) return { type, nodes: objectChildren(context, envelope.data, schema, [], 0, presentation.fields) }
  if (objectValue(envelope.data)) {
    // OpenAPI imports preserve the response under result. Keep that path for
    // authorization metadata, but avoid an otherwise redundant wrapper card.
    const keys = keysFor(envelope.data, schema)
    if (keys.length === 1 && keys[0] === 'result' && objectValue(own(envelope.data, 'result')) && !MASKED_STATES.has(effectiveState(context, ['result']).status)) {
      return { type, nodes: objectChildren(context, own(envelope.data, 'result'), schemaChild(schema, 'result'), ['result'], 0) }
    }
    return { type, nodes: objectChildren(context, envelope.data, schema, [], 0) }
  }
  return { type, nodes: [node(context, envelope.data, schema, [], 0)] }
}
