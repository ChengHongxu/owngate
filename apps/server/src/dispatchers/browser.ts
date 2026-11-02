// Browser HTTP dispatcher — calls webridge-browser RPC (design doc §13.1)
// Replaces the M0 stub dispatcher for browser-transport capabilities.

import { createHmac, randomUUID } from 'node:crypto'
import type { Connection, Capability, ResultEnvelope } from '@webridge/core'
import { err, fail, ok } from '@webridge/core'

const BROWSER_RPC_URL = process.env['BROWSER_RPC_URL'] ?? 'http://browser:4000'
const BROWSER_RPC_SECRET = process.env['BROWSER_RPC_SECRET'] ?? ''
const DEFAULT_DEADLINE_MS = 30_000

// ── HMAC signing ─────────────────────────────────────────────────────────

function signBody(body: string): { 'X-Wr-Sig': string; 'X-Wr-Ts': string } {
  const ts = Date.now().toString()
  const sig = createHmac('sha256', BROWSER_RPC_SECRET).update(body).digest('hex')
  return { 'X-Wr-Sig': sig, 'X-Wr-Ts': ts }
}

async function rpcPost<T>(path: string, payload: unknown): Promise<T> {
  const body = JSON.stringify(payload)
  const headers = signBody(body)
  const resp = await fetch(`${BROWSER_RPC_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body,
    signal: AbortSignal.timeout(DEFAULT_DEADLINE_MS),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`browser RPC ${path} → ${resp.status}: ${text}`)
  }
  return resp.json() as Promise<T>
}

// ── Session lifecycle (called by admin routes) ───────────────────────────

export async function openBrowserSession(
  connectionId: string,
  profilePath: string,
): Promise<{ session_id: string }> {
  return rpcPost('/v1/session/open', { connection_id: connectionId, profile_path: profilePath })
}

export async function closeBrowserSession(connectionId: string): Promise<{ ok: boolean }> {
  return rpcPost('/v1/session/close', { connection_id: connectionId })
}

export async function startLogin(
  connectionId: string,
  url: string,
  qrSelector?: string,
): Promise<{ stream_token: string }> {
  const payload: Record<string, unknown> = { connection_id: connectionId, url }
  if (qrSelector !== undefined) payload['qr_selector'] = qrSelector
  return rpcPost('/v1/login/start', payload)
}

export async function stopLogin(connectionId: string): Promise<{ ok: boolean }> {
  return rpcPost('/v1/login/stop', { connection_id: connectionId })
}

// ── Capability dispatch ───────────────────────────────────────────────────

interface RpcCheckResult {
  status: 'ok' | 'error'
  data?: unknown
  error?: { code: string; what_happened: string; next_step: string; retryable: boolean }
  meta?: unknown
}

export async function dispatchBrowser(
  connection: Connection,
  capability: Capability,
  input: unknown,
): Promise<ResultEnvelope> {
  const execId = randomUUID()
  const source = {
    connection_id: connection.id,
    connection_label: connection.label,
    capability_id: capability.id,
    support: connection.capability_states[capability.id] ?? capability.support,
  }

  let result: RpcCheckResult
  try {
    result = await rpcPost<RpcCheckResult>('/v1/check', {
      connection_id: connection.id,
      exec_id: execId,
      capability: capability.id,
      params: input,
      deadline_ms: DEFAULT_DEADLINE_MS,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Distinguish timeout vs other errors
    const code = msg.includes('timeout') || msg.includes('abort') ? 'TIMEOUT' : 'UPSTREAM_ERROR'
    return fail(err(code, `Browser RPC failed: ${msg}`), source)
  }

  if (result.status === 'error') {
    const rpcErr = result.error
    return fail(
      err(
        (rpcErr?.code as Parameters<typeof err>[0]) ?? 'UPSTREAM_ERROR',
        rpcErr?.what_happened ?? 'Browser capability execution failed',
      ),
      source,
    )
  }

  return ok(result.data, source)
}

// ── Login state probe ─────────────────────────────────────────────────────

interface ProbeResult {
  support: {
    status: string
    reason?: string
    probed_at?: string
  }
}

export async function probeCapability(
  connectionId: string,
  capabilityId: string,
): Promise<ProbeResult> {
  return rpcPost('/v1/probe', { connection_id: connectionId, capability: capabilityId })
}

export async function getBrowserHealth(): Promise<{ browsers: { connection_id: string; display: string }[] }> {
  const resp = await fetch(`${BROWSER_RPC_URL}/v1/health`, {
    signal: AbortSignal.timeout(5000),
  })
  if (!resp.ok) return { browsers: [] }
  return resp.json() as Promise<{ browsers: { connection_id: string; display: string }[] }>
}
