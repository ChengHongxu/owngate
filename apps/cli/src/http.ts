import { readConfig } from './config.js'

// The CLI only ever talks to client-token endpoints (/api/*, design §8.4):
// /admin/* needs an admin session and is never reachable with a CLI token.

/**
 * Message for a non-2xx body. Handles the envelope error object
 * ({error: {code, message}}), the admin shape ({error, code}) and plain text.
 */
function errorMessage(parsed: unknown, text: string): string {
  if (typeof parsed !== 'object' || parsed === null) return text
  const body = parsed as Record<string, unknown>
  const nested = body['error']
  if (typeof nested === 'object' && nested !== null) {
    const e = nested as Record<string, unknown>
    const message = typeof e['message'] === 'string' ? e['message'] : text
    return typeof e['code'] === 'string' ? `${e['code']}: ${message}` : message
  }
  for (const key of ['what_happened', 'message', 'error']) {
    const v = body[key]
    if (typeof v === 'string' && v !== '') {
      return typeof body['code'] === 'string' ? `${body['code']}: ${v}` : v
    }
  }
  return text
}

export async function apiCall(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<unknown> {
  const config = readConfig()
  const url = `${config.server.replace(/\/$/, '')}${path}`
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${config.token}`,
    'Content-Type': 'application/json',
  }
  const fetchOpts: RequestInit = { method, headers }
  if (body !== undefined) fetchOpts.body = JSON.stringify(body)
  const res = await fetch(url, fetchOpts)
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { message: text }
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${errorMessage(parsed, text)}`)
  }
  return parsed
}
