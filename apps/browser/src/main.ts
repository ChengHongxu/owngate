// Browser worker RPC server entry point (design doc §13.1)
// Exposes HMAC-authenticated HTTP endpoints + a WebSocket screencast channel.
//
// Every error body is {code, what_happened, next_step, retryable} with a §6.1
// code (see errors.ts): bad input → 400 INVALID_PARAMS, bad signature → 401
// UNAUTHENTICATED, browser trouble → 503 BROWSER_UNAVAILABLE, deadline → 504
// UPSTREAM_TIMEOUT, anything else → 500 INTERNAL_ERROR. /v1/check answers
// execution failures inside its own {status: 'error', error} shape instead.

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import Fastify, { type FastifyReply } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import { ScreencastSession, isValidConnectionId, parseScreenInput, parseEgressPolicy } from '@owngate/browser-runtime'
import type { LoginCondition } from '@owngate/browser-runtime'
import { makeHmacPlugin } from './auth.js'
import { SessionManager } from './session.js'
import { SocialGuard } from './social/guard.js'
import { BrowserDiagnostics } from './diagnostics.js'
import { execCapability, type ExecResult } from './exec.js'
import { validateImportedCookies } from './cookies.js'
import { parseLoginConditions } from './login-state.js'
import { readSecret } from './secrets.js'
import { probeLoginState, type ProbeTiming } from './probe.js'
import {
  MAX_DEADLINE_MS,
  classifyError,
  httpStatusFor,
  invalidParams,
  withDeadline,
  workerError,
  type WorkerError,
  type WorkerErrorCode,
} from './errors.js'

const PORT = parseInt(process.env['BROWSER_RPC_PORT'] ?? '4000', 10)
const PROFILES_DIR = process.env['BROWSER_PROFILES_DIR'] ?? '/profiles'

const QR_SNAPSHOT_INTERVAL_MS = 2_000
const CHECK_CACHE_TTL_MS = 10 * 60 * 1000
const WS_OPEN = 1
const MAX_ID_LENGTH = 128
const MAX_SELECTOR_LENGTH = 512
const MAX_URL_LENGTH = 2048

interface CheckCacheEntry {
  fingerprint: string
  result: ExecResult
  expiresAt: number
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>
    return '{' + Object.keys(object).sort().map((key) => JSON.stringify(key) + ':' + canonical(object[key])).join(',') + '}'
  }
  return JSON.stringify(value) ?? 'null'
}

/** Optional overrides, for tests. Production calls buildBrowserServer() with none. */
export interface BrowserServerDeps {
  /** Capability executor. Default: the real execCapability. */
  exec?: typeof execCapability
  /** Default: a SessionManager on BROWSER_PROFILES_DIR and BROWSER_EGRESS_PROXY. */
  sessionManager?: SessionManager
  /** /v1/probe redirect-settle timing. Default 1 s quiet, 5 s max. */
  probeTiming?: ProbeTiming
  socialGuard?: SocialGuard
}

// ── Request parsing ────────────────────────────────────────────────────────

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

function bodyOf(body: unknown): Record<string, unknown> | undefined {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined
}

function isNonEmptyString(v: unknown, max = MAX_ID_LENGTH): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max
}

function connectionIdError(v: unknown): string | undefined {
  return isValidConnectionId(v) ? undefined : 'connection_id must match /^[A-Za-z0-9_-]{1,64}$/'
}

function parseDeadline(v: unknown, required: boolean): Parsed<number | undefined> {
  if (v === undefined) {
    return required ? { ok: false, error: 'deadline_ms is required' } : { ok: true, value: undefined }
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_DEADLINE_MS) {
    return { ok: false, error: `deadline_ms must be a number in (0, ${MAX_DEADLINE_MS}]` }
  }
  return { ok: true, value: v }
}

function parseHttpUrl(v: unknown, field: string): Parsed<string> {
  if (!isNonEmptyString(v, MAX_URL_LENGTH)) return { ok: false, error: `${field} is required` }
  try {
    const u = new URL(v)
    if (u.protocol === 'http:' || u.protocol === 'https:') return { ok: true, value: v }
  } catch {
    // fall through
  }
  return { ok: false, error: `${field} must be an http(s) URL` }
}

function sendError(reply: FastifyReply, error: WorkerError) {
  return reply.status(httpStatusFor(error.code)).send(error)
}

const NEXT_STEP: Partial<Record<WorkerErrorCode, string>> = {
  BROWSER_UNAVAILABLE: 'retry; if it persists check Xvfb and Chromium in the browser container',
  UPSTREAM_TIMEOUT: 'retry with a longer deadline_ms',
  UPSTREAM_UNAVAILABLE: 'check the site is reachable through the egress proxy',
  INVALID_PARAMS: 'fix the request body',
}

function errorFrom(e: unknown, fallback: 'BROWSER_UNAVAILABLE' | 'INTERNAL_ERROR'): WorkerError {
  const code = classifyError(e, fallback)
  return workerError(
    code,
    e instanceof Error ? e.message : String(e),
    NEXT_STEP[code] ?? 'retry; report it if it persists',
  )
}

export async function buildBrowserServer(deps: BrowserServerDeps = {}) {
  // Read the secret at build time, not module load: tests set it in beforeAll.
  // An empty key would make every signature forgeable, so refuse to start.
  const rpcSecret = readSecret('BROWSER_RPC_SECRET')
  if (rpcSecret === undefined) {
    throw new Error('BROWSER_RPC_SECRET or BROWSER_RPC_SECRET_FILE must be set')
  }
  const exec = deps.exec ?? execCapability
  const egressProxy = process.env['BROWSER_EGRESS_PROXY']
  const egressSecret = egressProxy ? readSecret('EGRESS_CONTROL_SECRET') : undefined
  const sessionManager = deps.sessionManager ?? new SessionManager(PROFILES_DIR, egressProxy, {
    ...(egressProxy && egressSecret ? { egressControl: { baseUrl: process.env['BROWSER_EGRESS_CONTROL_URL'] ?? egressProxy, secret: egressSecret } } : {}),
  })
  const socialGuard = deps.socialGuard ?? (!deps.exec ? new SocialGuard(deps.sessionManager ? {} : { directory: PROFILES_DIR }) : undefined)
  const checkCache = new Map<string, CheckCacheEntry>()
  const inFlight = new Map<string, { fingerprint: string; result: Promise<ExecResult> }>()

  const app = Fastify({
    ...(process.env['VITEST'] ? { logger: { level: 'error' } } : {}),
  })
  // Close login waits and screencasts before Fastify waits for upgraded
  // sockets. Context.close flushes persistent profiles before egress revocation.
  const screencastStops = new Set<Promise<void>>()
  app.addHook('preClose', async () => {
    await sessionManager.closeAll()
    await Promise.allSettled([...screencastStops])
  })

  // Fastify's own errors (body parse, payload too large, bad content type)
  // and anything a handler throws get the fixed error body too.
  app.setErrorHandler((error: unknown, request, reply) => {
    const status = (error as { statusCode?: unknown } | null)?.statusCode
    const message = error instanceof Error ? error.message : String(error)
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.status(status).send(invalidParams(message))
    }
    request.log.error({ err: message }, 'unhandled error')
    return reply
      .status(500)
      .send(workerError('INTERNAL_ERROR', 'internal error in the browser worker', 'retry; report it if it persists'))
  })
  app.setNotFoundHandler((request, reply) => {
    return reply
      .status(404)
      .send(invalidParams(`no such method: ${request.method} ${request.url.split('?')[0]}`))
  })

  await app.register(fastifyWebsocket)

  // HMAC auth on everything except GET /v1/health. Other GETs sign path + query.
  await app.register(makeHmacPlugin(rpcSecret))

  app.addHook('preHandler', async (request, reply) => {
    const body = bodyOf(request.body)
    if (!body || body['egress_policy'] === undefined) return
    if (!isValidConnectionId(body['connection_id'])) return sendError(reply, invalidParams('invalid connection_id'))
    try { sessionManager.configureEgress(body['connection_id'], parseEgressPolicy(body['egress_policy'])) }
    catch (error) { return sendError(reply, invalidParams(error instanceof Error ? error.message : 'invalid egress policy')) }
  })

  // ── Health ───────────────────────────────────────────────────────────────
  app.get('/v1/health', async () => {
    return sessionManager.getHealthStatus()
  })

  // ── POST /v1/session/open ─────────────────────────────────────────────────
  // {connection_id} only: the worker owns the profile layout (§13.1). A
  // profile_path from an older server is refused, not silently ignored.
  app.post('/v1/session/open', async (request, reply) => {
    const body = bodyOf(request.body)
    if (!body) return sendError(reply, invalidParams('body must be a JSON object'))
    const bad = connectionIdError(body['connection_id'])
    if (bad) return sendError(reply, invalidParams(bad))
    const extra = Object.keys(body).filter((k) => k !== 'connection_id' && k !== 'egress_policy')
    if (extra.length > 0) {
      return sendError(
        reply,
        invalidParams(`unexpected field(s): ${extra.join(', ')}; the worker assigns profile, display and proxy itself`),
      )
    }
    try {
      return reply.send(await sessionManager.openSession(body['connection_id'] as string))
    } catch (e) {
      return sendError(reply, errorFrom(e, 'BROWSER_UNAVAILABLE'))
    }
  })

  // ── POST /v1/session/close ────────────────────────────────────────────────
  app.post('/v1/session/close', async (request, reply) => {
    const body = bodyOf(request.body)
    const bad = connectionIdError(body?.['connection_id'])
    if (!body || bad) return sendError(reply, invalidParams(bad ?? 'body must be a JSON object'))
    await sessionManager.closeSession(body['connection_id'] as string)
    return reply.send({ ok: true })
  })

  // ── POST /v1/login/start ──────────────────────────────────────────────────
  // success_when is required: without it the wait could only end in timeout.
  app.post('/v1/login/start', async (request, reply) => {
    const body = bodyOf(request.body)
    if (!body) return sendError(reply, invalidParams('body must be a JSON object'))
    const bad = connectionIdError(body['connection_id'])
    if (bad) return sendError(reply, invalidParams(bad))
    const url = parseHttpUrl(body['url'], 'url')
    if (!url.ok) return sendError(reply, invalidParams(url.error))
    if (body['success_when'] === undefined) {
      return sendError(reply, invalidParams('success_when is required'))
    }
    const conditions = parseLoginConditions(body['success_when'])
    if (!conditions.ok) return sendError(reply, invalidParams(conditions.error))
    const qrSelector = body['qr_selector']
    if (qrSelector !== undefined && !isNonEmptyString(qrSelector, MAX_SELECTOR_LENGTH)) {
      return sendError(reply, invalidParams('qr_selector must be a non-empty string'))
    }
    const deadline = parseDeadline(body['deadline_ms'], false)
    if (!deadline.ok) return sendError(reply, invalidParams(deadline.error))
    try {
      return reply.send(
        await sessionManager.startLogin(body['connection_id'] as string, url.value, {
          successWhen: conditions.conditions,
          ...(qrSelector !== undefined ? { qrSelector } : {}),
          ...(deadline.value !== undefined ? { deadlineMs: deadline.value } : {}),
        }),
      )
    } catch (e) {
      return sendError(reply, errorFrom(e, 'BROWSER_UNAVAILABLE'))
    }
  })

  // ── POST /v1/login/stop ───────────────────────────────────────────────────
  app.post('/v1/login/stop', async (request, reply) => {
    const body = bodyOf(request.body)
    const bad = connectionIdError(body?.['connection_id'])
    if (!body || bad) return sendError(reply, invalidParams(bad ?? 'body must be a JSON object'))
    await sessionManager.stopLogin(body['connection_id'] as string)
    return reply.send({ ok: true })
  })

  // ── GET /v1/login/status ──────────────────────────────────────────────────
  // Signed: the HMAC covers the path + query (see auth.ts for why).
  app.get<{ Querystring: { connection_id?: string } }>(
    '/v1/login/status',
    async (request, reply) => {
      const bad = connectionIdError(request.query.connection_id)
      if (bad) return sendError(reply, invalidParams(bad))
      return reply.send(sessionManager.getLoginState(request.query.connection_id as string))
    },
  )

  // ── POST /v1/cookies/import ───────────────────────────────────────────────
  // Responses and errors never echo cookie values, only names and domains.
  app.post('/v1/cookies/import', async (request, reply) => {
    const body = bodyOf(request.body)
    if (!body) return sendError(reply, invalidParams('body must be a JSON object'))
    const bad = connectionIdError(body['connection_id'])
    if (bad) return sendError(reply, invalidParams(bad))
    const validated = validateImportedCookies(body['cookies'])
    if (!validated.ok) return sendError(reply, invalidParams(validated.error))

    let successWhen: LoginCondition[] | undefined
    if (body['success_when'] !== undefined) {
      const parsed = parseLoginConditions(body['success_when'])
      if (!parsed.ok) return sendError(reply, invalidParams(parsed.error))
      successWhen = parsed.conditions
    }

    try {
      const result = await sessionManager.importCookies(
        body['connection_id'] as string,
        validated.cookies,
        successWhen,
      )
      return reply.send({
        logged_in: result.logged_in,
        cookies: validated.cookies.map((c) => ({ name: c.name, domain: c.domain })),
      })
    } catch (e) {
      // Fixed texts only: a browser error message could quote a cookie.
      const code = classifyError(e, 'BROWSER_UNAVAILABLE')
      if (code === 'INVALID_PARAMS') {
        return sendError(
          reply,
          workerError(code, 'the browser rejected the cookie batch', 'check cookie domains and paths, then retry'),
        )
      }
      return sendError(
        reply,
        workerError(code, 'cookies could not be written to the browser', NEXT_STEP[code] ?? 'retry'),
      )
    }
  })

  // ── POST /v1/check (idempotent) ──────────────────────────────────────────
  // Execution failures (deadline, browser down, a throwing handler) come back
  // as 200 {status: 'error', error} like any other execution result; only
  // results the executor produced are cached for exec_id replay.
  app.post('/v1/check', async (request, reply) => {
    const body = bodyOf(request.body)
    if (!body) return sendError(reply, invalidParams('body must be a JSON object'))
    const bad = connectionIdError(body['connection_id'])
    if (bad) return sendError(reply, invalidParams(bad))
    const execId = body['exec_id']
    if (!isNonEmptyString(execId)) return sendError(reply, invalidParams('exec_id is required'))
    const capability = body['capability']
    if (!isNonEmptyString(capability)) return sendError(reply, invalidParams('capability is required'))
    const connectorId = body['connector_id']
    if (connectorId !== undefined && !isNonEmptyString(connectorId)) {
      return sendError(reply, invalidParams('connector_id must be a non-empty string'))
    }
    const params = body['params'] ?? {}
    if (bodyOf(params) === undefined) return sendError(reply, invalidParams('params must be an object'))
    if (body['diagnostics'] !== undefined && typeof body['diagnostics'] !== 'boolean') return sendError(reply, invalidParams('diagnostics must be a boolean'))
    const diagnostics = body['diagnostics'] === true ? new BrowserDiagnostics() : undefined
    const deadline = parseDeadline(body['deadline_ms'], true)
    if (!deadline.ok || deadline.value === undefined) {
      return sendError(reply, invalidParams(deadline.ok ? 'deadline_ms is required' : deadline.error))
    }
    const deadlineMs = deadline.value
    const connectionId = body['connection_id'] as string

    if (sessionManager.isLoginInProgress(connectionId)) {
      diagnostics?.start('browser.session', '准备浏览器会话')('error', '当前连接的远程登录尚未结束', 'LOGIN_REQUIRED')
      return reply.send({ status: 'error', error: workerError('LOGIN_REQUIRED', 'finish the current remote login before querying', 'complete login in the admin screen'),
        ...(diagnostics ? { diagnostics: diagnostics.finish() } : {}) })
    }

    const fingerprint = canonical({ connectionId, connectorId: connectorId ?? 'bilibili', capability, params, diagnostics: Boolean(diagnostics) })
    const now = Date.now()
    for (const [id, entry] of checkCache) if (entry.expiresAt <= now) checkCache.delete(id)
    // Bind execution ids to their original inputs, including the connection.
    // A result must never be replayed for a different account or operation.
    const cached = checkCache.get(execId)
    const running = inFlight.get(execId)
    if ((cached && cached.fingerprint !== fingerprint) || (running && running.fingerprint !== fingerprint)) {
      return sendError(reply, invalidParams('exec_id was already used with different connection, capability or params'))
    }
    if (cached) {
      return reply.send(cached.result)
    }
    if (running) return reply.send(await running.result)

    const result = (async (): Promise<ExecResult> => {
      const sessionReady = diagnostics?.start('browser.session', '准备浏览器会话')
      try {
        // The in-flight promise is shared before waiting on the connection
        // lock, so simultaneous retries cannot execute the operation twice.
        const output = await withDeadline(deadlineMs, (signal) =>
          sessionManager.withLockedEntry(
            connectionId,
            async (entry) => {
              sessionReady?.('success', '已取得此连接的独立会话和执行锁')
              const guardReady = socialGuard ? diagnostics?.start('browser.guard', '检查查询频率与账号状态') : undefined
              const stopped = await socialGuard?.before(connectionId)
              if (stopped) {
                guardReady?.('error', stopped.error?.what_happened, stopped.error?.code)
                return stopped
              }
              guardReady?.('success', '本次查询符合冷却期和每日预算')
              const args = [entry.context, capability, params as Record<string, unknown>, deadlineMs, signal, connectorId] as const
              const result = diagnostics ? await exec(...args, diagnostics) : await exec(...args)
              await socialGuard?.after(connectionId, result)
              return result
            },
            signal,
          ),
        )
        const recorded = diagnostics ? { ...output, diagnostics: diagnostics.finish() } : output
        checkCache.set(execId, { fingerprint, result: recorded, expiresAt: Date.now() + CHECK_CACHE_TTL_MS })
        return recorded
      } catch (e) {
        const error = errorFrom(e, 'BROWSER_UNAVAILABLE')
        diagnostics?.interrupt(error.code)
        return { status: 'error', error, ...(diagnostics ? { diagnostics: diagnostics.finish() } : {}) }
      } finally {
        inFlight.delete(execId)
      }
    })()
    inFlight.set(execId, { fingerprint, result })
    return reply.send(await result)
  })

  // Explicit operator action; the server must require step-up and audit it.
  app.post('/v1/safety/resume', async (request, reply) => {
    const body = bodyOf(request.body)
    const bad = connectionIdError(body?.['connection_id'])
    if (!body || bad) return sendError(reply, invalidParams(bad ?? 'body must be an object'))
    await socialGuard?.resume(body['connection_id'] as string)
    return reply.send({ ok: true })
  })

  // ── POST /v1/cancel ──────────────────────────────────────────────────────
  app.post('/v1/cancel', async (request, reply) => {
    const body = bodyOf(request.body)
    if (!body || !isNonEmptyString(body['exec_id'])) {
      return sendError(reply, invalidParams('exec_id is required'))
    }
    // M1: no in-flight exec registry yet — report best-effort state.
    return reply.send({ cancel_state: 'requested' })
  })

  // ── POST /v1/probe ───────────────────────────────────────────────────────
  // Login state, not "is a browser running" (§13.1). Outcomes, including a
  // missed deadline, are 200 {status, reason?, account?}.
  app.post('/v1/probe', async (request, reply) => {
    const body = bodyOf(request.body)
    if (!body) return sendError(reply, invalidParams('body must be a JSON object'))
    const bad = connectionIdError(body['connection_id'])
    if (bad) return sendError(reply, invalidParams(bad))
    const loginUrl = parseHttpUrl(body['login_url'], 'login_url')
    if (!loginUrl.ok) return sendError(reply, invalidParams(loginUrl.error))
    const conditions = parseLoginConditions(body['success_when'])
    if (!conditions.ok) return sendError(reply, invalidParams(conditions.error))
    const whoami = body['whoami']
    if (whoami !== undefined && !isNonEmptyString(whoami)) {
      return sendError(reply, invalidParams('whoami must be a non-empty capability id'))
    }
    const connectorId = body['connector_id']
    if (connectorId !== undefined && !isNonEmptyString(connectorId)) {
      return sendError(reply, invalidParams('connector_id must be a non-empty string'))
    }
    const deadline = parseDeadline(body['deadline_ms'], true)
    if (!deadline.ok || deadline.value === undefined) {
      return sendError(reply, invalidParams(deadline.ok ? 'deadline_ms is required' : deadline.error))
    }
    return reply.send(
      await probeLoginState(
        sessionManager,
        async (...args) => {
          const stopped = await socialGuard?.before(body['connection_id'] as string)
          if (stopped) return stopped
          const result = await exec(...args)
          await socialGuard?.after(body['connection_id'] as string, result)
          return result
        },
        {
          connectionId: body['connection_id'] as string,
          loginUrl: loginUrl.value,
          successWhen: conditions.conditions,
          ...(whoami !== undefined ? { whoami } : {}),
          ...(connectorId !== undefined ? { connectorId } : {}),
          deadlineMs: deadline.value,
        },
        deps.probeTiming ?? {},
      ),
    )
  })

  // ── GET /v1/screencast (WebSocket) ────────────────────────────────────────
  // The socket holds a lease while open (no idle reclaim under a viewer) and
  // is closed by the worker when the login session ends.
  app.get('/v1/screencast', { websocket: true }, async (socket, request) => {
    const token = (request.query as { token?: string }).token
    if (typeof token !== 'string') {
      socket.close(1008, 'missing token')
      return
    }
    const connectionId = sessionManager.resolveStreamToken(token)
    if (connectionId === undefined) {
      socket.close(1008, 'invalid or expired token')
      return
    }
    if (!sessionManager.isLoginInProgress(connectionId)) {
      socket.close(1000, 'login session ended')
      return
    }

    let closed = false
    let session: ScreencastSession | undefined
    let qrTimer: NodeJS.Timeout | undefined
    let onContextClose: (() => void) | undefined
    // When the worker closes the socket it cleans up at once instead of
    // waiting for the 'close' event, which only fires after the closing
    // handshake (up to ws's 30 s timeout with an unresponsive peer).
    const closeWith = (code: number, reason: string) => {
      cleanup()
      socket.close(code, reason)
    }
    const detach = sessionManager.attachScreen(connectionId, () => {
      closeWith(1000, 'login session ended')
    })
    const entry = sessionManager.getEntry(connectionId)
    const cleanup = () => {
      if (closed) return
      closed = true
      detach()
      if (qrTimer) clearInterval(qrTimer)
      if (onContextClose) entry?.context.off('close', onContextClose)
      if (session) {
        const stopped = session.stop().catch((e: Error) => {
          app.log.debug({ err: e.message }, 'screencast stop failed')
        })
        screencastStops.add(stopped)
        void stopped.finally(() => screencastStops.delete(stopped))
      }
    }
    socket.on('close', cleanup)
    socket.on('error', cleanup)

    const page = entry?.context.pages()[0]
    if (!entry || !page) {
      closeWith(1011, 'no browser session')
      return
    }
    onContextClose = () => closeWith(1011, 'browser closed')
    entry.context.once('close', onContextClose)

    const viewport = page.viewportSize()
    if (!viewport) {
      closeWith(1011, 'browser viewport unavailable')
      return
    }
    const qrSelector = sessionManager.getQrSelector(connectionId)
    const started = new ScreencastSession(page)
    try {
      await started.start({}, (data, ts) => {
        if (socket.readyState === WS_OPEN) {
          socket.send(JSON.stringify({ type: 'frame', data, ts, width: viewport.width, height: viewport.height }))
        }
      })
    } catch (e) {
      app.log.error({ err: (e as Error).message }, 'screencast failed to start')
      closeWith(1011, 'screencast failed')
      return
    }
    if (closed) {
      // The socket went away while the screencast was starting.
      started.stop().catch(() => undefined)
      return
    }
    session = started

    // The HMAC-authenticated upgrade and one-use stream token identify the
    // connection. Only bounded, explicit input commands reach CDP. Queue them
    // to preserve key/mouse order and never log text or password contents.
    let inputQueue = Promise.resolve()
    let pendingInputs = 0
    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      if (closed || isBinary || raw.length > 16_384) return
      let message: unknown
      try { message = JSON.parse(raw.toString()) } catch { return }
      const envelope = bodyOf(message)
      if (envelope?.['type'] !== 'input') return
      const input = parseScreenInput(envelope['event'])
      if (!input || pendingInputs >= 100) return
      pendingInputs++
      inputQueue = inputQueue.then(async () => {
        if (!closed) await started.input(input)
      }).catch(() => {
        if (!closed && socket.readyState === WS_OPEN) {
          socket.send(JSON.stringify({ type: 'input_error', message: '页面暂时无法接收输入，请重试或重新打开画面。' }))
        }
      }).finally(() => { pendingInputs-- })
    })

    let qrPending = false
    const sendQrSnapshot = async () => {
      if (closed || qrPending) return
      qrPending = true
      try {
        const data = await started.captureQrSnapshot(qrSelector).catch(() => null)
        if (!closed && socket.readyState === WS_OPEN) {
          // null clears a code that disappeared, including transient failures;
          // retaining an old login QR would invite scanning an expired code.
          socket.send(JSON.stringify({ type: 'qr', data, ts: Date.now() }))
        }
      } finally {
        qrPending = false
      }
    }
    qrTimer = setInterval(() => { void sendQrSnapshot() }, QR_SNAPSHOT_INTERVAL_MS)
    void sendQrSnapshot()
  })

  return { app, sessionManager }
}

// ── Start only when this module is the entry point ────────────────────────
const entryArg = process.argv[1]
const isMain =
  entryArg !== undefined && import.meta.url === pathToFileURL(resolve(entryArg)).href

if (isMain) {
  const { app } = await buildBrowserServer()
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void app.close().then(() => process.exit(0), () => process.exit(1))
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try { await app.listen({ port: PORT, host: '0.0.0.0' }) }
  catch (error) { await app.close(); throw error }
  app.log.info(`owngate-browser listening on port ${PORT}`)
}
