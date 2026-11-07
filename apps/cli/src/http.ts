import { readConfig } from './config.js'
import type { Config } from './config.js'

export const DEFAULT_TIMEOUT_MS = 30_000

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: unknown, message: string) { super(message); this.name = 'ApiError' }
}

export class ApiTimeoutError extends Error {
  constructor(readonly timeoutMs: number) { super(`Request timed out after ${timeoutMs} ms`); this.name = 'ApiTimeoutError' }
}

function errorMessage(parsed: unknown, text: string): string {
  if (typeof parsed !== 'object' || parsed === null) return text
  const body = parsed as Record<string, unknown>
  const nested = body['error']
  if (typeof nested === 'object' && nested !== null) {
    const error = nested as Record<string, unknown>
    const message = typeof error['message'] === 'string' ? error['message'] : 'Request failed'
    return typeof error['code'] === 'string' ? `${error['code']}: ${message}` : message
  }
  for (const key of ['what_happened', 'message', 'error']) {
    const value = body[key]
    if (typeof value === 'string' && value !== '') return typeof body['code'] === 'string' ? `${body['code']}: ${value}` : value
  }
  return text
}

export interface ApiCallOptions {
  config?: Config; timeoutMs?: number; preferAsync?: boolean
  maxResponseBytes?: number
  signal?: AbortSignal
  onResponse?: (response: Pick<Response, 'status' | 'headers'>) => void
}

export async function apiCall(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: unknown,
  options: ApiCallOptions = {},
): Promise<unknown> {
  const config = options.config ?? readConfig()
  const configuredTimeout = Number(process.env['OWNGATE_TIMEOUT_MS'])
  const timeoutMs = options.timeoutMs ?? (configuredTimeout > 0 && Number.isFinite(configuredTimeout) ? configuredTimeout : DEFAULT_TIMEOUT_MS)
  const url = `${config.server.replace(/\/$/, '')}${path}`
  const fetchOptions: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', ...(options.preferAsync ? { Prefer: 'respond-async' } : {}) },
    redirect: 'error',
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)))])
      : AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
  }
  if (body !== undefined) fetchOptions.body = JSON.stringify(body)
  let response: Response
  let text: string
  try {
    response = await fetch(url, fetchOptions)
    if (options.maxResponseBytes === undefined) text = await response.text()
    else {
      const chunks: Uint8Array[] = []
      let length = 0
      for await (const chunk of response.body ?? []) {
        length += chunk.byteLength
        // Leaving the iterator cancels the stream, including chunked bodies
        // whose Content-Length is absent or inaccurate.
        if (length > options.maxResponseBytes) throw new Error('Response too large')
        chunks.push(chunk)
      }
      text = Buffer.concat(chunks).toString('utf8')
    }
  } catch (error) {
    if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw new ApiTimeoutError(timeoutMs)
    throw new Error('Cannot reach the owngate server. Check its address and network connection.')
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { parsed = { message: text } }
  options.onResponse?.(response)
  if (!response.ok) throw new ApiError(response.status, parsed, `HTTP ${response.status}: ${errorMessage(parsed, text)}`)
  return parsed
}
