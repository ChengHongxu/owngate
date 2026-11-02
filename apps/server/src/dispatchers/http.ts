// HTTP dispatcher — executes HTTP-transport capabilities via the declarative manifest.
// Design doc §4.1: manifest-driven HTTP requests with template rendering,
// expression-based success/auth-failure detection, and output mapping.

import { createHash } from 'node:crypto'
import type { Connection, Capability, ResultEnvelope } from '@webridge/core'
import { err, fail, ok } from '@webridge/core'
import { renderTemplate, evalExpr, pathGet, applyTransform } from '@webridge/connector-runtime'

interface HttpExecResult {
  status: number
  body: unknown
}

/**
 * §6.1: UPSTREAM_ERROR is retryable for a site 5xx and not for a 4xx. Any
 * other status leaves it unjudged, which err() treats as retryable.
 */
function upstreamRetryable(status: number): { retryable?: boolean } {
  if (status >= 500) return { retryable: true }
  if (status >= 400) return { retryable: false }
  return {}
}

export async function dispatchHttp(
  connection: Connection,
  capability: Capability,
  input: unknown,
  creds: Record<string, string>,
  manifestHttp?: {
    base: string
    headers?: Record<string, string>
    rate_limit?: { rpm: number }
    timeout_ms?: number
  },
  outputDefs?: Record<string, { from: string; transform?: string; unit?: string; scope?: string; sensitivity?: string }>,
  successWhen?: string,
  authFailedWhen?: string,
  requestDef?: { method: string; path: string },
): Promise<ResultEnvelope> {
  const source = {
    connection_id: connection.id,
    connection_label: connection.label,
    capability_id: capability.id,
    support: connection.capability_states[capability.id] ?? capability.support,
  }

  if (!manifestHttp) {
    return fail(err('INTERNAL_ERROR', 'No HTTP manifest for this connector'), source)
  }

  if (!requestDef) {
    return fail(err('INTERNAL_ERROR', 'No request definition for this capability'), source)
  }

  // ── Render request URL and headers from templates ────────────────────────
  const tplCtx = {
    config: connection.config as Record<string, unknown>,
    secret: creds,
    input: (input as Record<string, unknown>) ?? {},
  }

  let baseUrl: string
  let path: string
  try {
    const renderedBase = renderTemplate(manifestHttp.base, tplCtx)
    baseUrl = renderedBase.value
    const renderedPath = renderTemplate(requestDef.path, tplCtx, { urlEncodeInput: true })
    path = renderedPath.value
  } catch (e) {
    return fail(err('INVALID_PARAMS', `URL template error: ${(e as Error).message}`), source)
  }

  // Construct full URL, ensure path doesn't escape base origin
  const url = new URL(path, baseUrl).toString()
  if (!url.startsWith(baseUrl)) {
    return fail(err('INTERNAL_ERROR', 'Request path escapes base URL'), source)
  }

  // Render headers
  const headers: Record<string, string> = {}
  if (manifestHttp.headers) {
    for (const [key, template] of Object.entries(manifestHttp.headers)) {
      try {
        const rendered = renderTemplate(template, tplCtx)
        headers[key] = rendered.value
      } catch (e) {
        return fail(err('INVALID_PARAMS', `Header "${key}" template error: ${(e as Error).message}`), source)
      }
    }
  }

  // ── Execute HTTP request ─────────────────────────────────────────────────
  let result: HttpExecResult
  try {
    const resp = await fetch(url, {
      method: requestDef.method,
      headers,
      signal: AbortSignal.timeout(manifestHttp.timeout_ms ?? 10000),
    })
    const text = await resp.text()
    let body: unknown = text
    try { body = JSON.parse(text) } catch { /* keep as text */ }
    result = { status: resp.status, body }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const code = msg.includes('timeout') || msg.includes('abort') ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR'
    return fail(err(code, `HTTP request failed: ${msg}`), source)
  }

  // ── Evaluate success / auth-failure conditions ───────────────────────────
  const exprCtx = { response: result.body, status: result.status }

  if (authFailedWhen) {
    const authResult = evalExpr(authFailedWhen, exprCtx)
    if (authResult.value) {
      return fail(err('AUTH_REJECTED', 'Site rejected credentials (401/403)'), source)
    }
  }

  if (successWhen) {
    const successResult = evalExpr(successWhen, exprCtx)
    if (!successResult.value) {
      return fail(
        err('UPSTREAM_ERROR', `Success condition not met: status=${result.status}`, upstreamRetryable(result.status)),
        source,
      )
    }
  } else if (result.status >= 400) {
    return fail(err('UPSTREAM_ERROR', `HTTP ${result.status}`, upstreamRetryable(result.status)), source)
  }

  // ── Map output fields ────────────────────────────────────────────────────
  if (!outputDefs) {
    return ok(result.body, source)
  }

  const outData: Record<string, unknown> = {}
  for (const [field, def] of Object.entries(outputDefs)) {
    let value = pathGet(result.body, def.from)
    if (def.transform) {
      try {
        value = applyTransform(def.transform, value, {
          ...(((connection.config as Record<string, unknown>)['quota_per_unit']) !== undefined
            ? { quota_per_unit: (connection.config as Record<string, unknown>)['quota_per_unit'] as number }
            : {}),
        })
      } catch (e) {
        return fail(err('INTERNAL_ERROR', `Transform '${def.transform}' failed: ${(e as Error).message}`), source)
      }
    }
    outData[field] = value
  }

  return ok(outData, source)
}
