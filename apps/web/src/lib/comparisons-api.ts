import { request, type Envelope } from './api'

export interface ComparisonLink {
  connection_id: string
  view_id: string
  item_id: string
  target_connection_id: string
  created_at: string
}

export interface ComparisonRow {
  item_id: string
  label: string
  source_value: { value: number | null; unit: string; updated_at: string | null }
  target_connection_id: string | null
  target: Envelope | null
  comparison: {
    status: 'comparable' | 'unlinked' | 'unknown_unit' | 'unavailable'
    unit?: string
    difference?: number
    reason: string
  }
}

export interface ComparisonResult {
  outcome: 'success' | 'partial' | 'error'
  source: Envelope
  rows: ComparisonRow[]
}

const path = (id: string, viewId: string) => `/admin/connections/${encodeURIComponent(id)}/views/${encodeURIComponent(viewId)}`

export const comparisonsApi = {
  links: (id: string, viewId: string) => request<{ links: ComparisonLink[] }>(`${path(id, viewId)}/links`),
  setLink: (id: string, viewId: string, itemId: string, targetId: string) => request<ComparisonLink>(`${path(id, viewId)}/links/${encodeURIComponent(itemId)}`, { method: 'PUT', body: { target_connection_id: targetId } }),
  deleteLink: (id: string, viewId: string, itemId: string) => request<{ ok: true }>(`${path(id, viewId)}/links/${encodeURIComponent(itemId)}`, { method: 'DELETE' }),
  run: (id: string, viewId: string, input: Record<string, unknown>) => request<ComparisonResult>(`${path(id, viewId)}/run`, { method: 'POST', body: { input } }),
}

export function comparisonValue(value: number | null, unit: string): string {
  if (value === null) return '数值未知'
  return unit && unit !== 'unknown' ? `${value} ${unit}` : `${value}（单位未确认）`
}
