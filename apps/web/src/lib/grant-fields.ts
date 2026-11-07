import type { Capability, Grant } from './api'

export type GrantFieldKey = 'pii' | 'financial' | 'content'
export interface GrantFieldGroup {
  key: GrantFieldKey
  label: string
  /** At most three distinct labels; these are schema examples, not live data. */
  fields: string[]
  /** Distinct declared leaf paths per capability, bounded by the analysis budget. */
  count: number
}
export interface GrantFieldAnalysis {
  groups: GrantFieldGroup[]
  /** False when dynamic, unresolved or oversized schemas prevent a complete list. */
  complete: boolean
}
type FieldCapability = Pick<Capability, 'id' | 'title' | 'output'>
type Schema = Record<string, unknown>

const LABELS: Record<GrantFieldKey, string> = { pii: '个人信息', financial: '财务数据', content: '网站内容' }
const ORDER: GrantFieldKey[] = ['pii', 'financial', 'content']
const SECRET_KEY = /^(?:password|passwd|secret|token|.*_token|.*_secret|api[_-]?key|authorization|cookie|set-cookie)$/i
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_NODES = 1000
const MAX_DEPTH = 12
const EXAMPLE_LIMIT = 3
const FIELD_LABELS: Record<string, string> = {
  uid: '账户 ID', nickname: '昵称', username: '用户名', email: '邮箱',
  name: '名称', title: '标题', text: '正文', author: '作者', id: '标识',
  published_at: '发布时间', url: '链接', face_url: '头像', avatar_url: '头像',
  items: '条目', records: '记录',
}

function object(value: unknown): Schema | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Schema : undefined
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : undefined
}
function own(value: Schema, key: string): unknown { return Object.hasOwn(value, key) ? value[key] : undefined }
function category(schema: Schema): GrantFieldKey | undefined {
  const value = schema['x-sensitivity'] ?? 'content'
  return value === 'pii' || value === 'financial' || value === 'content' ? value : undefined
}
function secret(schema: Schema, key: string): boolean {
  return SECRET_KEY.test(key) || FORBIDDEN_KEYS.has(key) || schema['x-secret'] === true
    || schema['writeOnly'] === true || schema['x-sensitivity'] === 'secret'
}

/** All clients share these server defaults; saved field permissions take precedence. */
export function normalizeVisibility(saved?: Grant['visibility']): Record<GrantFieldKey, boolean> {
  return { pii: saved?.pii ?? false, financial: saved?.financial ?? true, content: saved?.content ?? true }
}

/**
 * The vault checks each property and array item before descending. A parent
 * gate therefore still applies when a descendant declares another category;
 * unspecified nodes have their own content gate, rather than overriding or
 * inheriting the closest annotation. One leaf can be affected by several
 * groups. The root schema itself is not gated by the vault.
 *
 * This only inspects schema metadata. It never reads a response, executes a
 * schema expression, or pretends to know dynamic field names.
 */
export function analyzeGrantFields(capabilities: FieldCapability[]): GrantFieldAnalysis {
  const groups = new Map<GrantFieldKey, { examples: Set<string>; paths: Set<string> }>()
  let complete = true
  let remaining = MAX_NODES
  const active = new Set<Schema>()

  function add(capability: FieldCapability, path: string[], gates: Set<GrantFieldKey>, labels: string[], named: boolean) {
    const identity = JSON.stringify([capability.id, ...path])
    const fallback = [text(capability.title) ?? capability.id, path.join('.')].filter(Boolean).join(' · ')
    const field = (named && labels.length ? labels.join(' · ') : fallback).slice(0, 80)
    for (const key of gates) {
      let group = groups.get(key)
      if (!group) { group = { examples: new Set(), paths: new Set() }; groups.set(key, group) }
      group.paths.add(identity)
      if (group.examples.size < EXAMPLE_LIMIT) group.examples.add(field)
    }
  }

  function visit(capability: FieldCapability, schema: Schema, path: string[], gates: Set<GrantFieldKey>, labels: string[], depth: number, key?: string, named = false) {
    if (remaining-- <= 0 || depth > MAX_DEPTH || active.has(schema)) { complete = false; return }
    let nextGates = gates
    if (key !== undefined) {
      if (secret(schema, key)) return
      const group = category(schema)
      // Unknown classifications are always hidden by the vault.
      if (!group) return
      nextGates = new Set([...gates, group])
    }
    if (['$ref', 'oneOf', 'anyOf', 'allOf', 'patternProperties'].some(keyword => own(schema, keyword) !== undefined)) complete = false
    const rawTypes = Array.isArray(schema['type']) ? schema['type'] : [schema['type']]
    const types = rawTypes.filter(type => type !== 'null')
    if (types.length > 1) complete = false
    const properties = object(schema['properties'])
    const isArray = types.includes('array')
    const isObject = types.includes('object') || properties !== undefined
    active.add(schema)
    if (isObject) {
      const additional = schema['additionalProperties']
      if (additional !== false && (additional === true || object(additional) || !properties)) complete = false
      for (const [childKey, raw] of Object.entries(properties ?? {})) {
        if (remaining <= 0) { complete = false; break }
        const child = object(raw)
        if (!child) { complete = false; continue }
        if (secret(child, childKey)) continue
        const declared = text(child['title'])
        const common = Object.hasOwn(FIELD_LABELS, childKey) ? FIELD_LABELS[childKey] : undefined
        const childLabel = declared ?? common
        const childLabels = childLabel ? [...labels, childLabel] : [...labels, text(childKey) ?? '字段']
        visit(capability, child, [...path, childKey], nextGates, childLabels, depth + 1, childKey, named || childLabel !== undefined)
      }
    } else if (isArray) {
      const item = object(schema['items'])
      if (!item) complete = false
      else {
        const itemTitle = text(item['title'])
        const itemLabels = itemTitle ? [...(text(schema['title']) ? labels : labels.slice(0, -1)), itemTitle] : labels
        visit(capability, item, [...path, '[]'], nextGates, itemLabels, depth + 1, '', named || itemTitle !== undefined)
      }
    } else if (types.some(type => ['string', 'number', 'integer', 'boolean', 'null'].includes(String(type)))) {
      add(capability, path, nextGates, labels, named)
    } else if (rawTypes.length === 1 && rawTypes[0] === 'null') {
      add(capability, path, nextGates, labels, named)
    } else complete = false
    active.delete(schema)
  }

  for (const capability of capabilities) {
    if (remaining <= 0) { complete = false; break }
    visit(capability, capability.output, [], new Set(), [], 0)
  }
  return { groups: ORDER.flatMap(key => {
    const group = groups.get(key)
    return group ? [{ key, label: LABELS[key], fields: [...group.examples], count: group.paths.size }] : []
  }), complete }
}

export function grantFieldGroups(capabilities: FieldCapability[]): GrantFieldGroup[] {
  return analyzeGrantFields(capabilities).groups
}
