import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProgram } from '../src/index.js'
import { readConfig, writeConfig } from '../src/config.js'
import { apiCall, ApiError } from '../src/http.js'
import { durationMs } from '../src/commands/task.js'

let directory: string
const source = { connection_id: 'conn', connection_label: 'Fixture', capability_id: 'account.balance', support: { status: 'supported' } }
const envelope = (status = 'ok', code?: string) => ({
  status, outcome: code ? 'error' : status === 'partial' ? 'partial' : 'success', data: code ? null : { balance: 1 },
  error: code ? { code, message: 'Fixture failure', retryable: false } : null,
  source, fields: {}, queried_at: '2026-11-02', data_time: '2026-11-02', cache: null, warnings: [],
})

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'owngate-cli-test-'))
  vi.stubEnv('OWNGATE_CONFIG_DIR', directory)
  writeConfig({ server: 'http://fixture.invalid', token: 'fixture-client-token' })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  process.exitCode = 0
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  process.exitCode = 0
  rmSync(directory, { recursive: true, force: true })
})

function respond(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith('/api/connections') && typeof body === 'object' && body !== null && 'source' in body) {
      return new Response(JSON.stringify({ connections: [{ id: 'conn', connector_id: 'fixture', label: 'Fixture', granted: ['account.balance'] }] }), { status: 200 })
    }
    return new Response(JSON.stringify(body), { status })
  }))
}
async function run(...args: string[]) { await createProgram(true).parseAsync(['node', 'owngate', ...args]) }

describe('CLI automation', () => {
  it('uses an isolated configurable directory and keeps the credential file private', () => {
    expect(readConfig().server).toBe('http://fixture.invalid')
    expect(statSync(join(directory, 'config.json')).mode & 0o777).toBe(0o600)
  })

  it.each([
    ['forbidden', 'PERMISSION_DENIED', 403, 7],
    ['needs_reauth', 'AUTH_EXPIRED', 500, 6],
    ['error', 'INVALID_PARAMS', 400, 2],
  ])('retains the error envelope and exit code for %s', async (status, code, http, expectedExit) => {
    const body = envelope(status as string, code as string)
    respond(http as number, body)
    await run('query', 'conn', 'account.balance', '--json')
    expect(process.exitCode).toBe(expectedExit)
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toEqual(body)
  })

  it('returns the partial exit code and JSON in a noninteractive process', async () => {
    respond(200, envelope('partial'))
    await run('query', 'conn', 'account.balance')
    expect(process.exitCode).toBe(3)
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string).status).toBe('partial')
  })

  it('passes typed JSON parameters to schema validation on the server', async () => {
    respond(200, envelope())
    await run('query', 'conn', 'account.balance', '--param', 'limit=10', '--param', 'active=true')
    const request = vi.mocked(fetch).mock.calls.find(([, options]) => options?.method === 'POST')![1]!
    expect(JSON.parse(request.body as string).input).toEqual({ limit: 10, active: true })
  })

  it('fails a noninteractive login without explicit credentials immediately', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await run('login')
    expect(process.exitCode).toBe(2)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('verifies explicit login credentials before replacing the saved configuration', async () => {
    respond(401, { error: { code: 'UNAUTHENTICATED', message: 'Invalid token' } })
    await run('login', '--server', 'http://another.invalid', '--token', 'bad-token')
    expect(process.exitCode).toBe(7)
    expect(readConfig().server).toBe('http://fixture.invalid')
  })

  it('returns pending with task_id when task polling reaches its deadline', async () => {
    respond(200, { id: 'task-1', status: 'running' })
    await run('task', 'get', 'task-1', '--wait', '10ms')
    expect(process.exitCode).toBe(4)
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toMatchObject({ status: 'pending', task_id: 'task-1' })
  })

  it('stops waiting when a task reaches a terminal state', async () => {
    respond(200, { id: 'task-1', status: 'success' })
    await run('task', 'get', 'task-1', '--wait', '1s')
    expect(process.exitCode).toBe(0)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('uses an abort deadline for all HTTP calls and retains structured non-2xx bodies', async () => {
    respond(403, { error: { code: 'PERMISSION_DENIED', message: 'Denied' } })
    await expect(apiCall('/api/test')).rejects.toMatchObject({ status: 403, body: { error: { code: 'PERMISSION_DENIED' } } })
    expect(vi.mocked(fetch).mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal)
    expect(ApiError.prototype).toBeInstanceOf(Error)
  })

  it('converts duration units and rejects unbounded or invalid waits', () => {
    expect(durationMs('500ms')).toBe(500)
    expect(durationMs('2m')).toBe(120000)
    expect(() => durationMs('forever')).toThrow()
    expect(() => durationMs('0')).toThrow()
  })

  it('creates fresh command options when an embedding process parses more than once', async () => {
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname
      requests.push({ path, ...(options.body ? { body: JSON.parse(String(options.body)) as Record<string, unknown> } : {}) })
      return new Response(JSON.stringify(path === '/api/connections'
        ? { connections: [{ id: 'conn', connector_id: 'fixture', label: 'Fixture', granted: ['account.balance'] }] }
        : path === '/api/query' ? { status: 'ok', results: [] } : envelope()), { status: 200 })
    }))
    await run('query', 'account.balance', '--all', '-p', 'limit=10')
    await run('query', 'Fixture', 'account.balance', '-p', 'active=true')
    expect(requests.filter(request => request.path === '/api/query')).toHaveLength(1)
    expect(requests.find(request => request.path === '/api/invoke')?.body).toMatchObject({ connection_id: 'conn', input: { active: true } })
    expect(requests.find(request => request.path === '/api/invoke')?.body?.['input']).not.toHaveProperty('limit')
  })

  it.each([
    ['query'],
    ['query', 'Fixture', ''],
    ['query', 'Fixture', '   '],
    ['query', '   '],
    ['query', 'Fixture', 'account.balance', '--all'],
    ['query', 'account.balance', '--all', '--tag', 'work'],
    ['query', 'account.balance', '--async', '--all'],
    ['query', 'account.balance', '--input', '[]'],
    ['query', 'account.balance', '--input', '{'],
    ['query', 'account.balance', '--param', 'limit'],
    ['query', 'account.balance', '--wait', '0'],
    ['feed', '--all', '--connection', 'Fixture'],
    ['feed', '--since', '0h'],
    ['feed', '--since', '366d'],
    ['action', 'propose', 'Fixture', 'job.run', '--input', '[]'],
    ['action', 'propose', 'Fixture', ''],
    ['cap', 'show', 'Fixture', ''],
  ])('rejects invalid local arguments before any network request: %j', async (...args) => {
    vi.stubGlobal('fetch', vi.fn())
    await run(...args)
    expect(process.exitCode).toBe(2)
    expect(fetch).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledTimes(2)
    expect(console.log).not.toHaveBeenCalled()
  })

  it.each([{}, { connections: null }, { connections: [{}] }, { connections: 'unexpected' }])('does not misreport a malformed API response as authenticated: %j', async body => {
    respond(200, body)
    await run('status')
    expect(process.exitCode).toBe(1)
    expect(console.log).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledTimes(2)
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain('fixture-client-token')
  })

  it.each([503, 401])('preserves an accepted task ticket if polling fails with HTTP %i', async status => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname
      if (path === '/api/connections') return new Response(JSON.stringify({ connections: [{ id: 'conn', connector_id: 'fixture', label: 'Fixture', granted: ['account.balance'] }] }), { status: 200 })
      if (options.method === 'POST') return new Response(JSON.stringify({ status: 'pending', task_id: 'accepted-task' }), { status: 202 })
      return new Response(JSON.stringify({ message: 'untrusted server body containing fixture-client-token' }), { status })
    }))
    await run('query', 'Fixture', 'account.balance')
    expect(process.exitCode).toBe(status === 401 ? 7 : 4)
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toEqual({ status: 'pending', task_id: 'accepted-task' })
    expect(vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain('fixture-client-token')
  })
})
