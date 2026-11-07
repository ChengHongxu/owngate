import type { FieldMeta } from '@owngate/core'
export type Platform = 'bilibili' | 'xiaohongshu' | 'zhihu' | 'x'
export interface SocialFeedItem {
  platform: Platform
  id: string
  url: string
  kind: 'video' | 'note' | 'answer' | 'article' | 'post'
  author: { id: string | null; name: string | null }
  title?: string
  text?: string
  media: { type: 'image' | 'video'; url: string }[]
  published_at: string | null
  metrics: { likes?: number; comments?: number; shares?: number; views?: number }
}
export interface NormalizedItem { data: SocialFeedItem; fields: Record<string, FieldMeta> }
export interface ItemError { index: number; code: 'ITEM_PARSE_FAILED'; reason: string }
export interface SocialBatch { items: NormalizedItem[]; errors: ItemError[]; nextCursor: string | null; hasMore: boolean | null }
export type ObjectValue = Record<string, unknown>
export const object = (value: unknown): ObjectValue => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ObjectValue : {}
export function at(value: unknown, ...path: string[]): unknown { return path.reduce<unknown>((current, key) => object(current)[key], value) }
export function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
export function id(value: unknown): string | null {
  return text(value) ?? (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null)
}
export function url(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try { const parsed = new URL(value.startsWith('//') ? 'https:' + value : value); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null } catch { return null }
}
export function count(value: unknown): number | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value)
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
export function timestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) value = value < 100_000_000_000 ? value * 1000 : value
  else if (typeof value !== 'string' || !/(?:\d{4}-|\w{3} \w{3} )/.test(value)) return null
  const date = new Date(value as string | number)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
export function plain(value: unknown): string | null {
  const string = text(value)
  return string === null ? null : string.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}
export function finish(item: SocialFeedItem, absent: string[] = []): NormalizedItem {
  const fields: Record<string, FieldMeta> = {}
  for (const field of ['author.id', 'author.name', 'published_at']) {
    const value = field === 'author.id' ? item.author.id : field === 'author.name' ? item.author.name : item.published_at
    if (value === null) absent.push(field)
  }
  for (const metric of ['likes', 'comments', 'shares', 'views']) if (!(metric in item.metrics)) absent.push('metrics.' + metric)
  for (const field of absent) fields[field] = { status: 'unknown', reason: '站点响应未提供可确认的值', sensitivity: 'content', untrusted: true }
  if (item.title !== undefined) fields['title'] = { status: 'ok', sensitivity: 'content', untrusted: true }
  if (item.text !== undefined) fields['text'] = { status: 'ok', sensitivity: 'content', untrusted: true }
  return { data: item, fields }
}
export function metrics(values: Record<string, unknown>): SocialFeedItem['metrics'] {
  return Object.fromEntries(Object.entries(values).flatMap(([key, value]) => { const parsed = count(value); return parsed === null ? [] : [[key, parsed]] }))
}
