import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildBrowserServer } from '../src/main.js'
import { signRequest } from '@webridge/browser-runtime'

const SECRET = 'test-rpc-secret'

let app: FastifyInstance

beforeAll(async () => {
  process.env['BROWSER_RPC_SECRET'] = SECRET
  const built = await buildBrowserServer()
  app = built.app
})

afterAll(async () => {
  await app.close()
})

function signed(body: unknown): Record<string, string> {
  const raw = JSON.stringify(body)
  return {
    'content-type': 'application/json',
    ...signRequest(raw, SECRET),
  }
}

describe('browser RPC HMAC auth', () => {
  it('allows GET /v1/health without a signature', async () => {
    const resp = await app.inject({ method: 'GET', url: '/v1/health' })
    expect(resp.statusCode).toBe(200)
    expect(JSON.parse(resp.body)).toHaveProperty('browsers')
  })

  it('rejects POST without signature headers', async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/v1/session/close',
      headers: { 'content-type': 'application/json' },
      payload: { connection_id: 'conn-1' },
    })
    expect(resp.statusCode).toBe(401)
    expect(JSON.parse(resp.body).code).toBe('UNAUTHENTICATED')
  })

  it('rejects a wrong signature', async () => {
    const body = { connection_id: 'conn-1' }
    const { 'X-Wr-Ts': ts } = signRequest(JSON.stringify(body), 'wrong-secret')
    const resp = await app.inject({
      method: 'POST',
      url: '/v1/session/close',
      headers: {
        'content-type': 'application/json',
        'X-Wr-Sig': 'ab'.repeat(32),
        'X-Wr-Ts': ts,
      },
      payload: body,
    })
    expect(resp.statusCode).toBe(401)
  })

  it('rejects a stale timestamp', async () => {
    const body = { connection_id: 'conn-1' }
    const { 'X-Wr-Sig': sig } = signRequest(JSON.stringify(body), SECRET)
    const resp = await app.inject({
      method: 'POST',
      url: '/v1/session/close',
      headers: {
        'content-type': 'application/json',
        'X-Wr-Sig': sig,
        'X-Wr-Ts': String(Date.now() - 120_000),
      },
      payload: body,
    })
    expect(resp.statusCode).toBe(401)
  })

  it('accepts a correctly signed request', async () => {
    const body = { connection_id: 'conn-nonexistent' }
    const resp = await app.inject({
      method: 'POST',
      url: '/v1/session/close',
      headers: signed(body),
      payload: body,
    })
    expect(resp.statusCode).toBe(200)
    expect(JSON.parse(resp.body)).toEqual({ ok: true })
  })
})

describe('browser RPC protocol shapes', () => {
  it('/v1/cancel accepts a signed exec_id', async () => {
    const body = { exec_id: 'exec-1' }
    const resp = await app.inject({
      method: 'POST',
      url: '/v1/cancel',
      headers: signed(body),
      payload: body,
    })
    expect(resp.statusCode).toBe(200)
    expect(JSON.parse(resp.body)).toHaveProperty('cancel_state')
  })

  it('/v1/screencast rejects a missing token', async () => {
    const resp = await app.inject({ method: 'GET', url: '/v1/screencast' })
    // Without websocket upgrade the route returns 400-ish; must not 200
    expect(resp.statusCode).not.toBe(200)
  })
})
