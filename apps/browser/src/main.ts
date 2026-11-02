// Browser worker RPC server entry point (design doc §13.1)
// Exposes HMAC-authenticated HTTP endpoints + a WebSocket screencast channel.

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import Fastify from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import { ScreencastSession } from '@webridge/browser-runtime'
import { makeHmacPlugin } from './auth.js'
import { SessionManager } from './session.js'
import { execCapability, type ExecResult } from './exec.js'

const PORT = parseInt(process.env['BROWSER_RPC_PORT'] ?? '4000', 10)
const PROFILES_DIR = process.env['BROWSER_PROFILES_DIR'] ?? '/profiles'

const QR_SNAPSHOT_INTERVAL_MS = 2_000
const CHECK_CACHE_TTL_MS = 10 * 60 * 1000
const WS_OPEN = 1

interface CheckCacheEntry {
  result: ExecResult
  expiresAt: number
}

export async function buildBrowserServer() {
  // Read the secret at build time, not module load: tests set it in beforeAll.
  const rpcSecret = process.env['BROWSER_RPC_SECRET'] ?? ''
  const sessionManager = new SessionManager(PROFILES_DIR, process.env['BROWSER_EGRESS_PROXY'])
  const checkCache = new Map<string, CheckCacheEntry>()

  const app = Fastify({
    ...(process.env['VITEST'] ? { logger: { level: 'error' } } : {}),
  })

  await app.register(fastifyWebsocket)

  // HMAC auth on everything except GET /v1/health (no body to sign)
  await app.register(makeHmacPlugin(rpcSecret))

  // ── Health ───────────────────────────────────────────────────────────────
  app.get('/v1/health', async () => {
    return sessionManager.getHealthStatus()
  })

  // ── POST /v1/session/open ─────────────────────────────────────────────────
  app.post<{
    Body: {
      connection_id: string
      profile_path: string
      xvfb_display?: string
      proxy_url?: string
    }
  }>('/v1/session/open', async (request, reply) => {
    const { connection_id, profile_path } = request.body
    try {
      // profile_path is the profile base dir; the pool appends /<connection_id>.
      return reply.send(await sessionManager.openSession(connection_id, profile_path))
    } catch (e) {
      return reply.status(500).send({
        code: 'INTERNAL',
        what_happened: (e as Error).message,
        next_step: 'check Xvfb and browser launch',
        retryable: true,
      })
    }
  })

  // ── POST /v1/session/close ────────────────────────────────────────────────
  app.post<{ Body: { connection_id: string } }>('/v1/session/close', async (request, reply) => {
    await sessionManager.closeSession(request.body.connection_id)
    return reply.send({ ok: true })
  })

  // ── POST /v1/login/start ──────────────────────────────────────────────────
  app.post<{
    Body: {
      connection_id: string
      url: string
      qr_selector?: string
      deadline_ms?: number
    }
  }>('/v1/login/start', async (request, reply) => {
    const { connection_id, url, qr_selector, deadline_ms } = request.body
    try {
      return reply.send(
        await sessionManager.startLogin(connection_id, url, qr_selector, deadline_ms),
      )
    } catch (e) {
      return reply.status(500).send({
        code: 'LOGIN_FAILED',
        what_happened: (e as Error).message,
        next_step: 'check url and browser state',
        retryable: true,
      })
    }
  })

  // ── POST /v1/login/stop ───────────────────────────────────────────────────
  app.post<{ Body: { connection_id: string } }>('/v1/login/stop', async (request, reply) => {
    await sessionManager.stopLogin(request.body.connection_id)
    return reply.send({ ok: true })
  })

  // ── POST /v1/check (idempotent) ──────────────────────────────────────────
  app.post<{
    Body: {
      connection_id: string
      exec_id: string
      capability: string
      params: Record<string, unknown>
      deadline_ms: number
    }
  }>('/v1/check', async (request, reply) => {
    const { exec_id, connection_id, capability, params, deadline_ms } = request.body

    // Idempotency: replay a cached result for a repeated exec_id
    const cached = checkCache.get(exec_id)
    if (cached && Date.now() < cached.expiresAt) {
      return reply.send(cached.result)
    }

    try {
      const entry = await sessionManager.entry(connection_id)
      // One execution at a time per connection (design §13.1): a second request
      // waits for the first instead of sharing the same browser context.
      const release = await entry.lock.acquire()
      let result: ExecResult
      try {
        result = await execCapability(entry.context, capability, params, deadline_ms)
      } finally {
        release()
      }
      checkCache.set(exec_id, {
        result,
        expiresAt: Date.now() + CHECK_CACHE_TTL_MS,
      })
      return reply.send(result)
    } catch (e) {
      return reply.status(500).send({
        status: 'error',
        error: {
          code: 'EXEC_FAILED',
          what_happened: (e as Error).message,
          next_step: 'retry with a fresh exec_id',
          retryable: true,
        },
      } satisfies ExecResult)
    }
  })

  // ── POST /v1/cancel ──────────────────────────────────────────────────────
  app.post<{ Body: { exec_id: string } }>('/v1/cancel', async (request, reply) => {
    // M1: no in-flight exec registry yet — report best-effort state.
    void request.body.exec_id
    return reply.send({ cancel_state: 'requested' })
  })

  // ── POST /v1/probe ───────────────────────────────────────────────────────
  app.post<{
    Body: { connection_id: string; capability: string }
  }>('/v1/probe', async (request, reply) => {
    const { connection_id } = request.body
    // M1: supported when a live session exists, otherwise needs_auth.
    const support = sessionManager.getEntry(connection_id) ? 'supported' : 'needs_auth'
    return reply.send({ support })
  })

  // ── GET /v1/screencast (WebSocket) ────────────────────────────────────────
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

    const entry = sessionManager.getEntry(connectionId)
    const page = entry?.context.pages()[0]
    if (!entry || !page) {
      socket.close(1011, 'no browser session')
      return
    }

    const session = new ScreencastSession(page)
    const qrSelector = sessionManager.getQrSelector(connectionId)
    let qrTimer: NodeJS.Timeout | undefined

    try {
      await session.start({}, (data, ts) => {
        if (socket.readyState === WS_OPEN) {
          socket.send(JSON.stringify({ type: 'frame', data, ts }))
        }
      })
    } catch (e) {
      app.log.error({ err: (e as Error).message }, 'screencast failed to start')
      socket.close(1011, 'screencast failed')
      return
    }

    qrTimer = setInterval(() => {
      void session
        .captureQrSnapshot(qrSelector)
        .then((data) => {
          if (socket.readyState === WS_OPEN) {
            socket.send(JSON.stringify({ type: 'qr', data, ts: Date.now() }))
          }
        })
        .catch(() => {
          // Snapshot failures are transient — keep the frame stream alive.
        })
    }, QR_SNAPSHOT_INTERVAL_MS)

    socket.on('close', () => {
      if (qrTimer) clearInterval(qrTimer)
      session.stop().catch((e: Error) => {
        app.log.debug({ err: e.message }, 'screencast stop failed')
      })
    })
    socket.on('error', () => {
      if (qrTimer) clearInterval(qrTimer)
    })
  })

  return { app, sessionManager }
}

// ── Start only when this module is the entry point ────────────────────────
const entryArg = process.argv[1]
const isMain =
  entryArg !== undefined && import.meta.url === pathToFileURL(resolve(entryArg)).href

if (isMain) {
  const { app } = await buildBrowserServer()
  await app.listen({ port: PORT, host: '0.0.0.0' })
  app.log.info(`webridge-browser listening on port ${PORT}`)
}
