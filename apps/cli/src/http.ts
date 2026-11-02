import { readConfig } from './config.js'

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
    const msg =
      parsed &&
      typeof parsed === 'object' &&
      'message' in (parsed as Record<string, unknown>)
        ? (parsed as Record<string, unknown>)['message'] as string
        : text
    throw new Error(`HTTP ${res.status}: ${msg}`)
  }
  return parsed
}

export async function adminCall(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<unknown> {
  const config = readConfig()
  const url = `${config.server.replace(/\/$/, '')}${path}`
  const headers: Record<string, string> = {
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
    const msg =
      parsed &&
      typeof parsed === 'object' &&
      'message' in (parsed as Record<string, unknown>)
        ? (parsed as Record<string, unknown>)['message'] as string
        : text
    throw new Error(`HTTP ${res.status}: ${msg}`)
  }
  return parsed
}
