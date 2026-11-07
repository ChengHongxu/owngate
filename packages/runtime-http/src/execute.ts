// HTTP dispatcher — executes HTTP-transport capabilities via the declarative manifest.
// Design doc §4.1: manifest-driven HTTP requests with template rendering,
// expression-based success/auth-failure detection, and output mapping.

import type { Connection, Capability, ResultEnvelope, FieldMeta } from '@owngate/core'
import { err, fail, ok } from '@owngate/core'
import { renderTemplate, evalExpr, pathGet, applyTransform, projectOutput, defaultInput } from '@owngate/connector-runtime'
import type { OutputFieldDef } from '@owngate/connector-runtime'
import { resolveHttpUrl } from './request.js'

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
  outputDefs?: Record<string, OutputFieldDef>,
  successWhen?: string,
  authFailedWhen?: string,
  requestDef?: { method: string; path: string; query?: Record<string, string> },
  discovery?: { quota_ratio: { path: string; from: string } },
  fetchUpstream: typeof fetch = fetch,
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
    input: defaultInput(input, capability.input),
  }

  let baseUrl: string
  let path: string
  try {
    const renderedBase = renderTemplate(manifestHttp.base, tplCtx)
    if (renderedBase.warnings.length) throw new Error(renderedBase.warnings.join('; '))
    baseUrl = renderedBase.value
    const renderedPath = renderTemplate(requestDef.path, tplCtx, { urlEncodeInput: true })
    if (renderedPath.warnings.length) throw new Error(renderedPath.warnings.join('; '))
    path = renderedPath.value
  } catch (e) {
    return fail(err('INVALID_PARAMS', `URL template error: ${(e as Error).message}`), source)
  }

  // Construct full URL, ensure path doesn't escape base origin
  let url: string
  try {
    url = resolveHttpUrl(connection, capability, input, manifestHttp, requestDef.path, requestDef.query).href
  } catch {
    return fail(err('INVALID_PARAMS', 'Invalid site URL'), source)
  }

  // Render headers
  const headers: Record<string, string> = {}
  if (manifestHttp.headers) {
    for (const [key, template] of Object.entries(manifestHttp.headers)) {
      try {
        const rendered = renderTemplate(template, tplCtx)
        if (rendered.warnings.length) throw new Error(rendered.warnings.join('; '))
        headers[key] = rendered.value
      } catch (e) {
        return fail(err('INVALID_PARAMS', `Header "${key}" template error: ${(e as Error).message}`), source)
      }
    }
  }

  // ── Execute HTTP request ─────────────────────────────────────────────────
  let result: HttpExecResult
  try {
    const resp = await fetchUpstream(url, {
      method: requestDef.method,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(manifestHttp.timeout_ms ?? 10000),
    })
    const text = await resp.text()
    let body: unknown = text
    try { body = JSON.parse(text) } catch { /* keep as text */ }
    result = { status: resp.status, body }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const brokerCode = (e as { code?: string } | null)?.code
    const code = brokerCode === 'AUTH_MISSING' || brokerCode === 'CAPABILITY_DISABLED' || brokerCode === 'GRANT_REVOKED' || brokerCode === 'UPSTREAM_TIMEOUT' ? brokerCode
      : /timeout|abort/i.test(msg) ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR'
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

  let ratio = Number(connection.config['quota_per_unit'])
  const warnings: string[] = []
  if (!(Number.isFinite(ratio) && ratio > 0) && discovery && Object.values(outputDefs).some((d) => d.transform === 'quota_to_usd')) {
    try {
      const statusUrl = new URL(discovery.quota_ratio.path, baseUrl)
      if (statusUrl.origin !== new URL(baseUrl).origin) throw new Error('Discovery path escapes site origin')
      const statusResponse = await fetchUpstream(statusUrl, {
        headers, redirect: 'error', signal: AbortSignal.timeout(manifestHttp.timeout_ms ?? 10000),
      })
      if (statusResponse.ok) {
        const rawRatio = pathGet(await statusResponse.json(), discovery.quota_ratio.from)
        if (typeof rawRatio === 'number' && Number.isFinite(rawRatio) && rawRatio > 0) ratio = rawRatio
      }
    } catch { /* A failed optional discovery preserves the original quota. */ }
  }

  const outData: Record<string, unknown> = {}
  const fields: Record<string, FieldMeta> = {}
  for (const [field, def] of Object.entries(outputDefs)) {
    let value = pathGet(result.body, def.from)
    const meta: FieldMeta = {
      status: value === undefined || value === null ? 'unknown' : 'ok',
      ...(def.unit !== undefined ? { unit: def.unit } : {}),
      ...(def.scope !== undefined ? { scope: def.scope } : {}),
      ...(def.sensitivity !== undefined ? { sensitivity: def.sensitivity } : {}),
      untrusted: true,
    }
    if (def.transform === 'quota_to_usd' && !(Number.isFinite(ratio) && ratio > 0)) {
      meta.unit = 'quota'
      meta.reason = '换算比例未知，保留站点原始 quota'
      warnings.push(`${field}: ${meta.reason}`)
      outData[field] = value ?? null
      fields[field] = meta
      continue
    }
    if (def.transform) {
      try {
        value = applyTransform(def.transform, value, {
          ...(Number.isFinite(ratio) && ratio > 0 ? { quota_per_unit: ratio } : {}),
        })
      } catch (e) {
        return fail(err('INTERNAL_ERROR', `Transform '${def.transform}' failed: ${(e as Error).message}`), source)
      }
    }
    if (def.schema) value = projectOutput(value, def.schema)
    outData[field] = value ?? null
    if (value === undefined || value === null) {
      meta.status = 'unknown'
      meta.reason = '站点未提供该字段或无法可靠转换'
    }
    fields[field] = meta
  }

  const envelope = ok(outData, source, { fields, warnings })
  if (Object.values(fields).some((f) => f.status === 'unknown')) {
    envelope.status = 'partial'
    envelope.outcome = 'partial'
  }
  return envelope
}
