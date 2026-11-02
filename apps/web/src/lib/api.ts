// API client for the admin backend.
// All admin routes are same-origin behind nginx (or the Vite dev proxy),
// so cookies travel with credentials: 'include'.

export interface Connection {
  id: string
  connector_id: string
  label: string
  config: Record<string, unknown>
  capability_states: Record<string, { status: string; reason?: string }>
  created_at: string
  updated_at: string
}

export interface Capability {
  id: string
  kind: 'query' | 'action'
  title: string
  description: string
  effect: string
  cache: { ttl: number } | null
  transport: 'http' | 'browser'
  support: { status: string }
}

export interface Envelope {
  outcome: 'success' | 'error' | 'partial'
  data: unknown
  error: { code: string; message: string } | null
  fields: Record<string, unknown>
  source: { connection_id: string; connection_label: string; capability_id: string }
  data_time: string
  queried_at: string
  cache: { hit: boolean } | null
  warnings: string[]
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  const text = await resp.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!resp.ok) {
    const b = body as { code?: string; message?: string; error?: string } | null
    throw new ApiError(resp.status, b?.code, b?.message ?? b?.error ?? text ?? resp.statusText)
  }
  return body as T
}

export const api = {
  // ── connections ──
  listConnections: () => call<{ connections: Connection[] }>('/admin/connections'),
  createConnection: (input: { connector_id: string; label: string; config: Record<string, unknown> }) =>
    call<Connection>('/admin/connections', { method: 'POST', body: JSON.stringify(input) }),
  deleteConnection: (id: string) =>
    call<{ ok: boolean }>(`/admin/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ── capabilities ──
  listCapabilities: (connectorId: string) =>
    call<{ capabilities: Capability[] }>(
      `/admin/capabilities?connector_id=${encodeURIComponent(connectorId)}`,
    ),

  // ── invoke ──
  invoke: (input: { connection_id: string; capability_id: string; input?: unknown; no_cache?: boolean }) =>
    call<Envelope>('/api/invoke', { method: 'POST', body: JSON.stringify(input) }),

  // ── browser remote screen ──
  openScreen: (connectionId: string, url: string, qrSelector?: string) =>
    call<{ ticket: string; ws_path: string }>(
      `/admin/screen/${encodeURIComponent(connectionId)}/open`,
      {
        method: 'POST',
        body: JSON.stringify({ url, ...(qrSelector !== undefined ? { qr_selector: qrSelector } : {}) }),
      },
    ),
  stopScreen: (connectionId: string) =>
    call<{ ok: boolean }>(`/admin/screen/${encodeURIComponent(connectionId)}/stop`, {
      method: 'POST',
    }),

  // ── login state ──
  startLogin: (connectionId: string, url: string, qrSelector?: string) =>
    call<{ stream_token: string }>('/admin/login/start', {
      method: 'POST',
      body: JSON.stringify({ connection_id: connectionId, url, ...(qrSelector !== undefined ? { qr_selector: qrSelector } : {}) }),
    }),
  stopLogin: (connectionId: string) =>
    call<{ ok: boolean }>(`/admin/login/${encodeURIComponent(connectionId)}/stop`, { method: 'POST' }),

  // ── health ──
  health: () => call<{ ok: boolean; time: string }>('/health'),
}

/** Open the screencast websocket for a connection and return the socket. */
export function openScreenSocket(wsPath: string): WebSocket {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(`${proto}//${window.location.host}${wsPath}`)
}
