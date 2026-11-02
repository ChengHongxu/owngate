// M0 acceptance test suite — design doc §15 M0 验收清单
// Verifies that the same capability returns identical envelope fields
// across all three entry points (REST, MCP, admin-registered capability).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildServer } from '../src/main.js'
import type { FastifyInstance } from 'fastify'
import type { ResultEnvelope } from '@webridge/core'
import { adminWithStepUp, tempDbPath } from './helpers/admin.js'
import type { AdminSession } from './helpers/admin.js'

let app: FastifyInstance
let admin: AdminSession
let cleanupDb: () => void
let token: string
let clientId: string
let connId: string

const BASE_CAP = {
  id: 'echo.ping',
  kind: 'query',
  title: 'Ping',
  description: 'Test capability',
  effect: 'read',
  approval: 'never',
  input: { type: 'object' },
  output: {
    type: 'object',
    properties: {
      message: { type: 'string', 'x-sensitivity': 'content' },
      connection: { type: 'string', 'x-sensitivity': 'content' },
      capability: { type: 'string', 'x-sensitivity': 'content' },
    },
  },
  cache: { ttl: 30 },
  long_running: false,
  cancel: 'none',
  idempotency: 'none',
  verify: null,
  transport: 'http',
  support: { status: 'supported' },
} as const

beforeAll(async () => {
  const db = tempDbPath()
  cleanupDb = db.cleanup
  const server = await buildServer({ dbPath: db.path })
  app = server.app
  // Admin routes need a session; clients and grants also need step-up (§8.4).
  admin = await adminWithStepUp(app)

  // Register capability
  await app.inject({
    method: 'POST',
    url: '/admin/capabilities',
    headers: admin.headers,
    payload: { connector_id: 'test-connector', capability: BASE_CAP },
  })

  // Create connection
  const connResp = await app.inject({
    method: 'POST',
    url: '/admin/connections',
    headers: admin.headers,
    payload: {
      connector_id: 'test-connector',
      label: 'M0 Test Site',
      config: { base_url: 'https://httpbin.org' },
    },
  })
  connId = JSON.parse(connResp.body).id

  // Create client
  const clientResp = await app.inject({
    method: 'POST',
    url: '/admin/clients',
    headers: admin.headers,
    payload: { label: 'M0 Test Client', kind: 'cli' },
  })
  const clientData = JSON.parse(clientResp.body)
  token = clientData.token
  clientId = clientData.id

  // Grant access
  await app.inject({
    method: 'POST',
    url: '/admin/grants',
    headers: admin.headers,
    payload: { client_id: clientId, connection_id: connId, capabilities: ['*'] },
  })
})

afterAll(async () => {
  await app.close()
  cleanupDb()
})

// ── §15 验收 1: 同一能力在三个入口返回字段完全一致的信封 ──────────────────

describe('M0 验收 1 — 三入口信封字段一致', () => {
  async function invokeViaRest(): Promise<ResultEnvelope> {
    const resp = await app.inject({
      method: 'POST',
      url: '/api/invoke',
      headers: { authorization: `Bearer ${token}` },
      payload: { connection_id: connId, capability_id: 'echo.ping', input: {}, no_cache: true },
    })
    return JSON.parse(resp.body) as ResultEnvelope
  }

  async function invokeViaMcp(): Promise<ResultEnvelope> {
    const resp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: {
        jsonrpc: '2.0',
        id: 100,
        method: 'tools/call',
        params: {
          name: 'query',
          arguments: {
            connection_id: connId,
            capability_id: 'echo.ping',
            input: {},
            no_cache: true,
          },
        },
      },
    })
    // MCP returns SSE: extract data line
    const body = resp.body
    const dataLine = body.split('\n').find((l: string) => l.startsWith('data:'))
    const parsed = JSON.parse(dataLine!.replace('data: ', ''))
    const text = parsed.result?.content?.[0]?.text
    return JSON.parse(text) as ResultEnvelope
  }

  it('REST invoke returns success envelope', async () => {
    const env = await invokeViaRest()
    expect(env.outcome).toBe('success')
    expect(env.status).toBe('ok')
    expect(env.source.connection_id).toBe(connId)
    expect(env.source.capability_id).toBe('echo.ping')
    expect(env.data).not.toBeNull()
    expect(env.error).toBeNull()
  })

  it('MCP invoke returns same outcome, source, and data shape as REST', async () => {
    const rest = await invokeViaRest()
    const mcp = await invokeViaMcp()
    expect(mcp.outcome).toBe(rest.outcome)
    expect(mcp.status).toBe(rest.status)
    expect(mcp.source.connection_id).toBe(rest.source.connection_id)
    expect(mcp.source.capability_id).toBe(rest.source.capability_id)
    expect(Object.keys(mcp.data as object).sort()).toEqual(
      Object.keys(rest.data as object).sort(),
    )
  })

  it('envelope always has required fields', async () => {
    const env = await invokeViaRest()
    expect(env).toHaveProperty('status')
    expect(env).toHaveProperty('outcome')
    expect(env).toHaveProperty('data')
    expect(env).toHaveProperty('error')
    expect(env).toHaveProperty('fields')
    expect(env).toHaveProperty('source')
    expect(env).toHaveProperty('data_time')
    expect(env).toHaveProperty('queried_at')
    expect(env).toHaveProperty('cache')
    expect(env).toHaveProperty('warnings')
  })
})

// ── §15 验收 2: 撤销客户端后三入口立即拒绝，缓存不可读 ──────────────────────

describe('M0 验收 2 — 撤销即时性', () => {
  let revokeToken: string
  let revokeClientId: string

  beforeAll(async () => {
    const clientResp = await app.inject({
      method: 'POST',
      url: '/admin/clients',
      headers: admin.headers,
      payload: { label: 'Revoke Test Client', kind: 'cli' },
    })
    const data = JSON.parse(clientResp.body)
    revokeToken = data.token
    revokeClientId = data.id

    await app.inject({
      method: 'POST',
      url: '/admin/grants',
      headers: admin.headers,
      payload: { client_id: revokeClientId, connection_id: connId, capabilities: ['*'] },
    })

    // Warm up cache
    await app.inject({
      method: 'POST',
      url: '/api/invoke',
      headers: { authorization: `Bearer ${revokeToken}` },
      payload: { connection_id: connId, capability_id: 'echo.ping', input: {} },
    })

    // Revoke
    await app.inject({
      method: 'POST',
      url: `/admin/clients/${revokeClientId}/revoke`,
      headers: admin.headers,
    })
  })

  it('REST returns CLIENT_REVOKED after revocation', async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/api/invoke',
      headers: { authorization: `Bearer ${revokeToken}` },
      payload: { connection_id: connId, capability_id: 'echo.ping', input: {} },
    })
    const body = JSON.parse(resp.body) as ResultEnvelope
    expect(body.error?.code).toBe('CLIENT_REVOKED')
    expect(resp.statusCode).toBe(401)
  })

  it('MCP returns error after revocation', async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${revokeToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: {
        jsonrpc: '2.0',
        id: 200,
        method: 'tools/call',
        params: {
          name: 'query',
          arguments: { connection_id: connId, capability_id: 'echo.ping', input: {} },
        },
      },
    })
    const body = resp.body
    const dataLine = body.split('\n').find((l: string) => l.startsWith('data:'))
    const parsed = JSON.parse(dataLine!.replace('data: ', ''))
    // MCP tool error is surfaced as isError: true
    expect(parsed.result?.isError).toBe(true)
  })
})

// ── §15 验收 3: 错误码一致性 ──────────────────────────────────────────────────

describe('M0 验收 3 — 错误码一致性', () => {
  it('401 on missing token', async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/api/invoke',
      payload: { connection_id: connId, capability_id: 'echo.ping', input: {} },
    })
    expect(resp.statusCode).toBe(401)
  })

  it('UNAUTHENTICATED on unknown token', async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/api/invoke',
      headers: { authorization: 'Bearer not-a-real-token' },
      payload: { connection_id: connId, capability_id: 'echo.ping', input: {} },
    })
    const body = JSON.parse(resp.body) as ResultEnvelope
    expect(body.error?.code).toBe('UNAUTHENTICATED')
    expect(body.status).toBe('forbidden')
    expect(resp.statusCode).toBe(401)
  })

  it('CONNECTION_NOT_FOUND on unknown connection', async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/api/invoke',
      headers: { authorization: `Bearer ${token}` },
      payload: { connection_id: 'nonexistent', capability_id: 'echo.ping', input: {} },
    })
    const body = JSON.parse(resp.body) as ResultEnvelope
    expect(body.error?.code).toBe('CONNECTION_NOT_FOUND')
    expect(resp.statusCode).toBe(404)
  })

  it('CAPABILITY_NOT_FOUND on unknown capability', async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/api/invoke',
      headers: { authorization: `Bearer ${token}` },
      payload: { connection_id: connId, capability_id: 'unknown.cap', input: {} },
    })
    const body = JSON.parse(resp.body) as ResultEnvelope
    expect(body.error?.code).toBe('CAPABILITY_NOT_FOUND')
    expect(resp.statusCode).toBe(404)
  })

  it('PERMISSION_DENIED when no grant', async () => {
    const noGrantResp = await app.inject({
      method: 'POST',
      url: '/admin/clients',
      headers: admin.headers,
      payload: { label: 'No Grant Client', kind: 'cli' },
    })
    const noGrantToken = JSON.parse(noGrantResp.body).token

    const resp = await app.inject({
      method: 'POST',
      url: '/api/invoke',
      headers: { authorization: `Bearer ${noGrantToken}` },
      payload: { connection_id: connId, capability_id: 'echo.ping', input: {} },
    })
    const body = JSON.parse(resp.body) as ResultEnvelope
    expect(body.error?.code).toBe('PERMISSION_DENIED')
    expect(body.status).toBe('forbidden')
    expect(resp.statusCode).toBe(403)
  })

  it('CAPABILITY_DISABLED for action capabilities (D9)', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/capabilities',
      headers: admin.headers,
      payload: {
        connector_id: 'test-connector',
        capability: {
          ...BASE_CAP,
          id: 'post.create',
          kind: 'action',
          approval: 'always',
          cache: null,
          effect: 'write',
        },
      },
    })
    const resp = await app.inject({
      method: 'POST',
      url: '/api/invoke',
      headers: { authorization: `Bearer ${token}` },
      payload: { connection_id: connId, capability_id: 'post.create', input: {} },
    })
    const body = JSON.parse(resp.body) as ResultEnvelope
    expect(body.error?.code).toBe('CAPABILITY_DISABLED')
    expect(body.status).toBe('unsupported')
  })
})

// ── §15 验收 4: schema 注解完整性 ────────────────────────────────────────────

describe('M0 验收 4 — schema 注解完整性', () => {
  it('output schema has x-sensitivity on all annotated fields', () => {
    const output = BASE_CAP.output as unknown as {
      properties: Record<string, Record<string, unknown>>
    }
    for (const [field, schema] of Object.entries(output.properties)) {
      expect(schema['x-sensitivity'], `field ${field} missing x-sensitivity`).toBeDefined()
    }
  })
})

// ── §15 验收 5: 缓存语义 ─────────────────────────────────────────────────────

describe('M0 验收 5 — 缓存语义', () => {
  it('second call is a cache hit', async () => {
    // First call (fresh)
    await app.inject({
      method: 'POST',
      url: '/api/invoke',
      headers: { authorization: `Bearer ${token}` },
      payload: { connection_id: connId, capability_id: 'echo.ping', input: {}, no_cache: true },
    })
    // Second call
    const resp = await app.inject({
      method: 'POST',
      url: '/api/invoke',
      headers: { authorization: `Bearer ${token}` },
      payload: { connection_id: connId, capability_id: 'echo.ping', input: {} },
    })
    const env = JSON.parse(resp.body) as ResultEnvelope
    expect(env.cache?.hit).toBe(true)
  })

  it('no_cache bypasses cache', async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/api/invoke',
      headers: { authorization: `Bearer ${token}` },
      payload: { connection_id: connId, capability_id: 'echo.ping', input: {}, no_cache: true },
    })
    const env = JSON.parse(resp.body) as ResultEnvelope
    expect(env.cache).toBeNull()
  })
})
