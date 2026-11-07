import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { fail, err, ok } from '@owngate/core'
import type { Dispatcher } from '@owngate/core'
import { DbClient } from '@owngate/db'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const bin = resolve(root, 'apps/cli/dist/bin.js')
const execute = promisify(execFile)
const cleanup: Array<() => Promise<void>> = []
beforeAll(async () => {
  await Promise.all(['cli', 'server'].map(name => execute(resolve(root, `apps/${name}/node_modules/.bin/tsc`), ['-p', 'tsconfig.json'], { cwd: resolve(root, `apps/${name}`) })))
}, 30_000)
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})

async function fixture(options: { delayMs?: number; longRunning?: boolean; fail?: boolean; startTasks?: boolean } = {}) {
  vi.stubEnv('MASTER_KEY_HEX', '44'.repeat(32))
  const directory = mkdtempSync(join(tmpdir(), 'owngate-query-'))
  cleanup.push(async () => { rmSync(directory, { recursive: true, force: true }) })
  const dbPath = join(directory, 'owngate.db')
  const seed = new DbClient(dbPath)
  await seed.upsertConnector({ id: 'test-connector', version: '1', title: 'Test', transport: 'http', manifest: {} })
  await seed.createConnection({ id: 'granted', connector_id: 'test-connector', label: 'Fixture', config: {}, capability_states: { 'echo.ping': { status: 'supported' } } })
  await seed.createClient({ id: 'cli-fixture', label: 'CLI', token_hash: createHash('sha256').update('query-fixture-token').digest('hex') })
  await seed.upsertGrant({ client_id: 'cli-fixture', connection_id: 'granted', capabilities: ['echo.ping'] })
  await seed.close()
  const { buildServer } = await import('../../server/dist/main.js')
  let dispatches = 0
  const requests: Array<{ method: string; url: string; prefer: string | undefined }> = []
  const dispatcher: Dispatcher = { dispatch: async (connection, capability) => {
    dispatches++
    if (options.delayMs) await delay(options.delayMs)
    const source = { connection_id: connection.id, connection_label: connection.label, capability_id: capability.id, support: { status: 'supported' as const } }
    return options.fail ? fail(err('AUTH_EXPIRED', 'Fixture credentials expired'), source) : ok({ message: 'durable once' }, source)
  } }
  const server = await buildServer({ dbPath, dispatcher, connectorsDir: resolve(root, 'packages/connector-runtime/test/fixtures/connectors') })
  server.connectorRegistry.getCapability('test-connector', 'echo.ping')!.long_running = options.longRunning ?? true
  server.app.addHook('onRequest', async (request) => {
    const prefer = request.headers['prefer']
    requests.push({ method: request.method, url: request.url, prefer: Array.isArray(prefer) ? prefer.join(', ') : prefer })
  })
  await server.app.listen({ port: 0, host: '127.0.0.1' })
  if (options.startTasks !== false) await server.taskService.start()
  cleanup.push(() => server.app.close())
  const port = (server.app.server.address() as { port: number }).port
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ server: `http://127.0.0.1:${port}`, token: 'query-fixture-token' }), { mode: 0o600 })
  const run = async (...args: string[]) => {
    const child = spawn(process.execPath, [bin, 'query', 'Fixture', 'echo.ping', ...args], {
      env: { ...process.env, OWNGATE_CONFIG_DIR: directory }, stdio: 'pipe',
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (data) => { stdout += String(data) })
    child.stderr.on('data', (data) => { stderr += String(data) })
    const code = await new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('query CLI exceeded the test process deadline')) }, 8000)
      child.once('close', code => { clearTimeout(timer); done(code) })
      child.once('error', reject)
    })
    return { code, stdout, stderr }
  }
  return { server, run, requests, dispatches: () => dispatches }
}

describe('spawned CLI long-running query', () => {
  it('negotiates one durable submission, polls and prints the final envelope with its normal exit code', async () => {
    const { server, run, requests, dispatches } = await fixture({ delayMs: 50 })
    const result = await run('--wait', '4s')
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'ok', outcome: 'success', data: { message: 'durable once' } })
    expect(result.stderr).toBe('')
    expect(dispatches()).toBe(1)
    expect(requests.filter(item => item.method === 'POST')).toEqual([{ method: 'POST', url: '/api/invoke', prefer: 'respond-async' }])
    expect(requests.some(item => item.method === 'GET' && item.url.startsWith('/api/tasks/'))).toBe(true)
    expect(await server.db.rawQuery('SELECT id FROM tasks')).toHaveLength(1)
  }, 12_000)

  it('returns pending and its accepted task ID when the bounded wait expires, without resubmission', async () => {
    const { server, run, requests, dispatches } = await fixture({ startTasks: false })
    const result = await run('--wait', '100ms')
    expect(result.code).toBe(4)
    const ticket = JSON.parse(result.stdout)
    expect(ticket).toEqual({ status: 'pending', task_id: expect.stringMatching(/^tsk_/) })
    expect(dispatches()).toBe(0)
    expect(requests.filter(item => item.method === 'POST')).toHaveLength(1)
    expect(await server.db.rawQuery('SELECT id,status FROM tasks')).toEqual([{ id: ticket.task_id, status: 'pending' }])
  }, 12_000)

  it('keeps --async immediate and exposes the same durable ticket', async () => {
    const { server, run, requests, dispatches } = await fixture({ startTasks: false })
    const result = await run('--async')
    expect(result.code).toBe(4)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'pending', task_id: expect.stringMatching(/^tsk_/) })
    expect(requests.map(item => `${item.method} ${item.url}`)).toEqual(['GET /api/connections', 'POST /api/tasks'])
    expect(await server.db.rawQuery('SELECT id FROM tasks')).toHaveLength(1)
    expect(dispatches()).toBe(0)
  }, 12_000)

  it('keeps ordinary capabilities synchronous without creating a task', async () => {
    const { server, run, requests, dispatches } = await fixture({ longRunning: false })
    const result = await run()
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'ok' })
    expect(requests.map(item => `${item.method} ${item.url}`)).toEqual(['GET /api/connections', 'POST /api/invoke'])
    expect(await server.db.rawQuery('SELECT id FROM tasks')).toEqual([])
    expect(dispatches()).toBe(1)
  }, 12_000)

  it('uses the completed task error envelope to select the standard exit code', async () => {
    const { run, dispatches } = await fixture({ fail: true })
    const result = await run('--wait', '4s')
    expect(result.code).toBe(6)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'needs_reauth', outcome: 'error', error: { code: 'AUTH_EXPIRED' } })
    expect(result.stdout + result.stderr).not.toContain('query-fixture-token')
    expect(dispatches()).toBe(1)
  }, 12_000)
})
