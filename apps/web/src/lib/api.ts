// API client for the admin backend.
// All admin routes are same-origin behind nginx (or the Vite dev proxy),
// so cookies travel with credentials: 'include'.
//
// 所有请求经 http.ts 的通用包装：
// - 403 STEP_UP_REQUIRED → 弹二次验证框，成功后自动重试一次
// - 401（会话丢失）→ 通知 App 回到登录页

import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser'
import { ApiError, createRequester, createStepUpGate } from './http'
import type { StepUpReason } from './http'
import type { CookieItem } from './cookies'
import type { ScreenStatus } from './screen'
import type { ConnectionHealth, SupportState } from '@owngate/core'

export { ApiError } from './http'

export interface Connection {
  id: string
  connector_id: string
  label: string
  config: Record<string, unknown>
  capability_states: Record<string, SupportState>
  health: ConnectionHealth
  created_at: string
  updated_at: string
  paused?: boolean
  scope?: 'personal' | 'organization'
  tags?: string[]
}

export interface PresentationField {
  path: string
  label?: string
  format?: 'text' | 'number' | 'datetime' | 'link' | 'badge'
  prominent?: boolean
}

export interface ResultPresentation {
  type: 'auto' | 'stats' | 'table' | 'list' | 'feed' | 'json'
  items?: string
  fields?: PresentationField[]
  columns?: PresentationField[]
  max_rows?: number
}

export interface Capability {
  id: string
  kind: 'query' | 'action'
  title: string
  description: string
  effect: string
  cache: { ttl: number } | null
  transport: 'http' | 'browser'
  support: SupportState
  input: Record<string, unknown>
  output: Record<string, unknown>
  presentation?: ResultPresentation
}

export interface Connector {
  id: string
  title: string
  transport: string
  has_auth: boolean
  has_login?: boolean
  views?: import('@owngate/core').ComparisonView[]
  config?: Record<string, unknown>
  auth?: { type: string; fields?: Record<string, unknown> }
}

export interface VerificationResult {
  verified: boolean
  capability_states: Connection['capability_states']
  results: Record<string, Envelope>
}

export interface Client {
  id: string
  label: string
  revoked: boolean
  created_at: string
  expires_at?: string | null
}

export interface Grant {
  client_id: string
  connection_id: string
  capabilities: string[]
  visibility?: { pii?: boolean; financial?: boolean; content?: boolean }
}

export interface Envelope {
  outcome: 'success' | 'error' | 'partial'
  data: unknown
  error: { code: string; message: string; retryable?: boolean; details?: Record<string, unknown> } | null
  fields: Record<string, unknown>
  source: { connection_id: string; connection_label: string; capability_id: string }
  data_time: string
  queried_at: string
  cache: { hit: boolean } | null
  warnings: string[]
  execution?: ExecutionTrace
}

export interface ExecutionStep {
  id: string
  label: string
  status: 'success' | 'partial' | 'error' | 'skipped'
  duration_ms: number
  detail?: string
  code?: string
}

export interface ExecutionTrace {
  id: string
  started_at: string
  duration_ms: number
  steps: ExecutionStep[]
}

export interface AuthStatus {
  hasUser: boolean
  authenticated: boolean
  stepUp: boolean
  totpEnabled: boolean
  passkeyCount: number
}

export interface Passkey {
  id: string
  createdAt: string
}

export interface Account {
  id: string
  username: string
  createdAt: string
}

export interface AccountChange {
  ok: true
  changed: boolean
  requiresLogin: boolean
}

export interface ScreenStatusBody {
  status: ScreenStatus
  reason?: string
  since: string | number
}

export interface CookieImportResult {
  logged_in: boolean
  cookies: { name: string; domain: string }[]
}

export interface ProbeResult {
  connectionId: string
  status: string
  reason?: string
}

// ── 会话丢失与二次验证的接线点 ────────────────────────────────────────────

const stepUpGate = createStepUpGate()
const sessionLostListeners = new Set<(err: ApiError) => void>()

/** 由 StepUpDialog 挂载时注册：返回 true 表示验证通过 */
export function setStepUpPrompt(prompt: ((reason?: StepUpReason) => Promise<boolean>) | null): void {
  stepUpGate.setPrompt(prompt)
}

/** App 订阅：任何后台请求返回 401（会话丢失）时触发 */
export function onSessionLost(listener: (err: ApiError) => void): () => void {
  sessionLostListeners.add(listener)
  return () => {
    sessionLostListeners.delete(listener)
  }
}

const call = createRequester({
  fetch: (input, init) => fetch(input, init),
  stepUp: (reason) => stepUpGate.request(reason),
  onSessionLost: (err) => {
    for (const l of sessionLostListeners) l(err)
  },
})

export const request = call

const enc = encodeURIComponent

export const api = {
  listClients: () => call<{ clients: Client[] }>('/admin/clients'),
  listGrants: () => call<{ grants: Grant[] }>('/admin/grants'),
  createClient: (input: { label: string; expires_at?: string | null }) =>
    call<Client & { token: string }>('/admin/clients', { method: 'POST', body: input }),
  revokeClient: (id: string) =>
    call<{ ok: boolean }>(`/admin/clients/${enc(id)}/revoke`, { method: 'POST' }),
  setGrant: (input: Grant) => call<Grant>('/admin/grants', { method: 'POST', body: input }),
  // ── connections ──
  listConnections: () => call<{ connections: Connection[] }>('/admin/connections'),
  createConnection: (input: { connector_id: string; label: string; config: Record<string, unknown>; scope?: 'personal' | 'organization'; confirm_organization?: boolean; tags?: string[] }) =>
    call<Connection>('/admin/connections', { method: 'POST', body: input }),
  deleteConnection: (id: string) =>
    call<{ ok: boolean }>(`/admin/connections/${enc(id)}`, { method: 'DELETE' }),
  updateConnection: (id: string, input: { config: Record<string, unknown>; label?: string }) =>
    call<Connection>(`/admin/connections/${enc(id)}`, { method: 'PATCH', body: input }),
  verifyConnection: (id: string, selection?: { capability_id: string; input: unknown }) =>
    call<VerificationResult>(`/admin/connections/${enc(id)}/verify`, { method: 'POST', ...(selection ? { body: selection } : {}) }),

  // ── connectors ──
  listConnectors: () =>
    call<{ connectors: Connector[] }>('/admin/connectors'),

  // ── credentials ──
  getCredentials: (connectionId: string) =>
    call<{ fields: Array<{ key: string; updated_at: string }> }>(
      `/admin/connections/${enc(connectionId)}/credentials`,
    ),
  setCredentials: (connectionId: string, credentials: Record<string, string>) =>
    call<VerificationResult & { ok: boolean }>(`/admin/connections/${enc(connectionId)}/credentials`, {
      method: 'PUT',
      body: { credentials },
    }),

  // ── capabilities ──
  listCapabilities: (connectorId: string, connectionId?: string) =>
    call<{ capabilities: Capability[] }>(`/admin/capabilities?connector_id=${enc(connectorId)}${connectionId ? `&connection_id=${enc(connectionId)}` : ''}`),

  // ── invoke ──
  invoke: (input: { connection_id: string; capability_id: string; input?: unknown; no_cache?: boolean }) =>
    call<Envelope>('/admin/invoke', { method: 'POST', body: input }),

  // ── browser remote screen（登录页地址由 server 从清单 login.url 取）──
  openScreen: (connectionId: string) =>
    call<{ ticket: string; ws_path: string }>(`/admin/screen/${enc(connectionId)}/open`, {
      method: 'POST',
      body: {},
    }),
  stopScreen: (connectionId: string) =>
    call<{ ok: boolean }>(`/admin/screen/${enc(connectionId)}/stop`, { method: 'POST' }),
  screenStatus: (connectionId: string) =>
    call<ScreenStatusBody>(`/admin/screen/${enc(connectionId)}/status`),

  // ── login state ──
  importCookies: (connectionId: string, cookies: CookieItem[]) =>
    call<CookieImportResult>(`/admin/connections/${enc(connectionId)}/cookies`, {
      method: 'POST',
      body: { cookies },
    }),
  probe: (connectionId: string) =>
    call<ProbeResult>(`/admin/probe/${enc(connectionId)}`, { method: 'POST' }),
  probeStatus: () =>
    call<{ lastRunAt: string | null; lastResults: ProbeResult[] }>('/admin/probe/status'),

  // ── health ──
  health: () => call<{ ok: boolean; time: string }>('/health'),
}

export const authApi = {
  status: () => call<AuthStatus>('/auth/status', { stepUp: false, sessionLost: false }),
  account: () => call<Account>('/auth/account'),
  updateAccount: (input: { username: string; current_password: string }) =>
    call<AccountChange>('/auth/account', { method: 'PATCH', body: input }),
  changePassword: (input: { current_password: string; new_password: string }) =>
    call<AccountChange>('/auth/account/password', { method: 'POST', body: input }),
  bootstrap: (username: string, password: string) =>
    call<{ id: string; expiresAt: string }>('/auth/bootstrap', {
      method: 'POST',
      body: { username, password },
      stepUp: false,
      sessionLost: false,
    }),
  login: (input: { username: string; password: string; totp?: string }) =>
    call<{ ok: boolean; expiresAt: string }>('/auth/login', {
      method: 'POST',
      body: input,
      stepUp: false,
      sessionLost: false,
    }),
  async loginPasskey(username: string, password: string): Promise<void> {
    const flow = await call<{ ticket: string; options: PublicKeyCredentialRequestOptionsJSON }>('/auth/login/passkey/begin', {
      method: 'POST', body: { username, password }, stepUp: false, sessionLost: false,
    })
    const response = await startAuthentication({ optionsJSON: flow.options })
    await call('/auth/login/passkey/finish', { method: 'POST', body: { ticket: flow.ticket, response }, stepUp: false, sessionLost: false })
  },
  logout: () =>
    call<{ ok: boolean }>('/auth/logout', { method: 'POST', stepUp: false, sessionLost: false }),

  // ── 二次验证（自身不能再走 step-up 包装）──
  async stepUpPasskey(): Promise<void> {
    const optionsJSON = await call<PublicKeyCredentialRequestOptionsJSON>('/auth/step-up/passkey/begin', {
      method: 'POST',
      stepUp: false,
    })
    const response = await startAuthentication({ optionsJSON })
    await call<{ ok: boolean }>('/auth/step-up/passkey/finish', {
      method: 'POST',
      body: { response },
      stepUp: false,
    })
  },
  stepUpTotp: (code: string, password: string) =>
    call<{ ok: boolean }>('/auth/step-up/totp', { method: 'POST', body: { code, password }, stepUp: false }),
  proveSetupPassword: (password: string) =>
    call<{ ok: boolean }>('/auth/mfa/setup', { method: 'POST', body: { password }, stepUp: false }),

  // ── passkeys ──
  listPasskeys: () => call<{ passkeys: Passkey[] }>('/auth/passkeys'),
  async registerPasskey(): Promise<void> {
    const optionsJSON = await call<PublicKeyCredentialCreationOptionsJSON>('/auth/passkeys/register/begin', {
      method: 'POST',
    })
    const response = await startRegistration({ optionsJSON })
    await call<{ ok: boolean }>('/auth/passkeys/register/finish', {
      method: 'POST',
      body: { response },
    })
  },
  deletePasskey: (id: string) => call<{ ok: boolean }>(`/auth/passkeys/${enc(id)}`, { method: 'DELETE' }),

  // ── TOTP ──
  // 已启用时重新 enroll 需要二次验证（§8.2 重新绑定），由通用包装弹框处理
  enrollTotp: () =>
    call<{ secretBase32: string; otpauthUrl: string; enabled: boolean }>('/auth/totp/enroll', {
      method: 'POST',
    }),
  confirmTotp: (code: string) =>
    call<{ ok: boolean; totpEnabled: boolean }>('/auth/totp/confirm', { method: 'POST', body: { code } }),
  disableTotp: () =>
    call<{ ok: boolean; totpEnabled: boolean }>('/auth/totp/disable', { method: 'POST' }),
}

/** Open the screencast websocket for a connection and return the socket. */
export function openScreenSocket(wsPath: string): WebSocket {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(`${proto}//${window.location.host}${wsPath}`)
}
