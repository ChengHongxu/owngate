import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildBrowserServer } from '../src/main.js'
import { signRequest } from '@owngate/browser-runtime'

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

function signed(body: unknown, path = '/v1/session/close'): Record<string, string> {
  const raw = JSON.stringify(body)
  return {
    'content-type': 'application/json',
    ...signRequest(raw, SECRET, { method: 'POST', path }),
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
    const { 'X-Og-Ts': ts, 'X-Og-Nonce': nonce } = signRequest(JSON.stringify(body), 'wrong-secret', { method: 'POST', path: '/v1/session/close' })
    const resp = await app.inject({
      method: 'POST',
      url: '/v1/session/close',
      headers: {
        'content-type': 'application/json',
        'X-Og-Sig': 'ab'.repeat(32),
        'X-Og-Ts': ts,
        'X-Og-Nonce': nonce,
      },
      payload: body,
    })
    expect(resp.statusCode).toBe(401)
  })

  it('rejects a stale timestamp', async () => {
    const body = { connection_id: 'conn-1' }
    const { 'X-Og-Sig': sig, 'X-Og-Nonce': nonce } = signRequest(JSON.stringify(body), SECRET, { method: 'POST', path: '/v1/session/close' })
    const resp = await app.inject({
      method: 'POST',
      url: '/v1/session/close',
      headers: {
        'content-type': 'application/json',
        'X-Og-Sig': sig,
        'X-Og-Ts': String(Date.now() - 120_000),
        'X-Og-Nonce': nonce,
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

  it('rejects a captured request replay and a refreshed timestamp', async () => {
    const body = { connection_id: 'replay-test' }
    const headers = signed(body)
    const request = { method: 'POST' as const, url: '/v1/session/close', headers, payload: body }
    expect((await app.inject(request)).statusCode).toBe(200)
    expect((await app.inject(request)).statusCode).toBe(401)
    expect((await app.inject({ ...request, headers: { ...headers, 'X-Og-Ts': String(Number(headers['X-Og-Ts']) + 1) } })).statusCode).toBe(401)
  })

  it('rejects a signature reused for a different POST endpoint', async () => {
    const body = { connection_id: 'route-test' }
    const response = await app.inject({ method: 'POST', url: '/v1/login/stop', headers: signed(body), payload: body })
    expect(response.statusCode).toBe(401)
  })
})

describe('browser RPC protocol shapes', () => {
  it('/v1/cancel accepts a signed exec_id', async () => {
    const body = { exec_id: 'exec-1' }
    const resp = await app.inject({
      method: 'POST',
      url: '/v1/cancel',
      headers: signed(body, '/v1/cancel'),
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
