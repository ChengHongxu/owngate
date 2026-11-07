import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { LATEST_PROTOCOL_VERSION, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { ok } from '@owngate/core'
import type { Dispatcher } from '@owngate/core'
import { DbClient } from '../../../packages/db/dist/index.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const bin = resolve(root, 'apps/cli/dist/bin.js')
const execute = promisify(execFile)
const cleanup: Array<() => Promise<void>> = []
beforeAll(async () => {
  // These are process tests of the shipped CLI against the shipped server.
  await Promise.all([
    execute('pnpm', ['--filter', '@owngate/cli', 'build'], { cwd: root }),
    execute('pnpm', ['--filter', '@owngate/server', 'build'], { cwd: root }),
  ])
}, 30_000)
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})

async function fixture() {
  vi.stubEnv('MASTER_KEY_HEX', '33'.repeat(32))
  vi.stubEnv('OWNGATE_TASKS_AUTOSTART', '0')
  const directory = mkdtempSync(join(tmpdir(), 'owngate-stdio-'))
  cleanup.push(async () => { rmSync(directory, { recursive: true, force: true }) })
  const dbPath = join(directory, 'owngate.db')
  const seed = new DbClient(dbPath)
  await seed.upsertConnector({ id: 'test-connector', version: '1', title: 'Test', transport: 'http', manifest: {} })
  for (const id of ['granted', 'hidden']) await seed.createConnection({ id, connector_id: 'test-connector', label: id, config: {}, capability_states: { 'echo.ping': { status: 'supported' } } })
  await seed.createClient({ id: 'cli-fixture', label: 'CLI', token_hash: createHash('sha256').update('stdio-fixture-token').digest('hex') })
  await seed.upsertGrant({ client_id: 'cli-fixture', connection_id: 'granted', capabilities: ['echo.ping'] })
  await seed.createAdminUser({ id: 'fixture-admin', username: 'fixture-admin', password_hash: 'fixture-never-used-hash' })
  await seed.insertLoginSession({ id: 'fixture-session', user_id: 'fixture-admin', expires_at: '2100-01-01T00:00:00.000Z' })
  await seed.close()
  const { buildServer } = await import('../../server/dist/main.js')
  const dispatcher: Dispatcher = { dispatch: async (connection, capability) => ok({ message: 'loopback fixture' }, {
    connection_id: connection.id, connection_label: connection.label, capability_id: capability.id, support: { status: 'supported' },
  }) }
  const server = await buildServer({ dbPath, dispatcher, connectorsDir: resolve(root, 'packages/connector-runtime/test/fixtures/connectors') })
  await server.app.listen({ port: 0, host: '127.0.0.1' })
  cleanup.push(() => server.app.close())
  const port = (server.app.server.address() as { port: number }).port
  const initialization = await server.app.inject({ method: 'POST', url: '/mcp',
    headers: { authorization: 'Bearer stdio-fixture-token', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {}, clientInfo: { name: 'direct-acceptance', version: '1' } } },
  })
  expect(initialization.statusCode).toBe(200)
  const initializationData = initialization.body.split('\n').find(line => line.startsWith('data:'))?.slice(5) ?? initialization.body
  const remoteInstructions = (JSON.parse(initializationData) as { result: { instructions?: string } }).result.instructions
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ server: `http://127.0.0.1:${port}`, token: 'stdio-fixture-token' }), { mode: 0o600 })
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp', '--transport', 'stdio', '--timeout', '3s'],
    env: { OWNGATE_CONFIG_DIR: directory }, stderr: 'pipe' })
  const client = new Client({ name: 'stdio-acceptance', version: '1' })
  const errors: Error[] = []
  let stderr = ''
  transport.stderr?.on('data', (data) => { stderr += String(data) })
  client.onerror = (error) => { errors.push(error) }
  cleanup.push(() => client.close())
  await client.connect(transport, { timeout: 5000 })
  return { client, transport, errors, stderr: () => stderr, server, remoteInstructions }
}

function jsonText(result: unknown): unknown {
  const text = (result as { content?: Array<{ type: string; text?: string }> }).content?.find((block) => block.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

describe('spawned non-TTY MCP stdio bridge', () => {
  it('forwards tools, schemas, calls and resources under the remote client grant', async () => {
    const { client, transport, errors, stderr, remoteInstructions } = await fixture()
    expect(transport.pid).toBeGreaterThan(0)
    expect(remoteInstructions).toBeTruthy()
    expect(client.getInstructions()).toBe(remoteInstructions)
    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['list_connections', 'list_capabilities', 'describe_capability', 'query']))
    expect(tools.tools.find((tool) => tool.name === 'query')?.inputSchema.properties).toHaveProperty('connection_id')
    const connections = jsonText(await client.callTool({ name: 'list_connections', arguments: {} })) as { connections: Array<{ id: string }> }
    expect(connections.connections.map((connection) => connection.id)).toEqual(['granted'])
    const allowed = jsonText(await client.callTool({ name: 'query', arguments: { connection_id: 'granted', capability_id: 'echo.ping', input: {} } }))
    expect(allowed).toMatchObject({ outcome: 'success', data: { message: 'loopback fixture' } })
    const denied = await client.callTool({ name: 'query', arguments: { connection_id: 'hidden', capability_id: 'echo.ping', input: {} } })
    expect(denied.isError).toBe(true)
    expect(jsonText(denied)).toMatchObject({ error: { code: 'PERMISSION_DENIED' } })
    const resources = await client.listResources()
    expect(resources.resources.map((resource) => resource.uri)).toContain('owngate://connections')
    const data = await client.readResource({ uri: 'owngate://connections' })
    expect(JSON.parse((data.contents[0] as { text: string }).text)).toMatchObject([{ id: 'granted' }])
    expect(JSON.stringify(data)).not.toContain('hidden')
    // SDK parsing reports non-JSON stdout as transport errors. No banner or
    // diagnostic output may corrupt the stdio protocol.
    expect(errors).toEqual([])
    expect(stderr()).not.toContain('stdio-fixture-token')
    await client.close()
    expect(transport.pid).toBeNull()
  }, 15_000)

  it('uses current revocation when a connected AI client calls again', async () => {
    const { client, server } = await fixture()
    expect(jsonText(await client.callTool({ name: 'list_connections', arguments: {} }))).toMatchObject({ connections: [{ id: 'granted' }] })
    const revoked = await server.app.inject({ method: 'POST', url: '/admin/clients/cli-fixture/revoke', headers: { cookie: 'og_session=fixture-session' } })
    expect(revoked.statusCode).toBe(200)
    // The stateful HTTP endpoint rejects a revoked token before reading the
    // protocol body. The bridge must propagate failure without returning data.
    await expect(client.callTool({ name: 'list_connections', arguments: {} })).rejects.toThrow('current client grant')
    await expect(client.readResource({ uri: 'owngate://connections' })).rejects.toThrow()
  }, 15_000)

  it('keeps the remote SSE stream alive and forwards tools/list_changed to the local AI client', async () => {
    const { client, server, errors } = await fixture()
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true)
    // Exceed the bridge's 3s per-request timeout while the SSE stream is idle.
    // A healthy notification stream must not inherit a request body deadline.
    await delay(3200)
    let received!: () => void
    const notification = new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('The stdio bridge did not forward tools/list_changed')), 2500)
      received = () => { clearTimeout(timer); done() }
    })
    client.setNotificationHandler(ToolListChangedNotificationSchema, received)
    await server.mcpController.notifyChanged('cli-fixture')
    await notification
    expect(errors).toEqual([])
    await client.close()
  }, 15_000)

  it('bounds initial network waits and keeps all diagnostics off stdout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'owngate-stdio-timeout-'))
    cleanup.push(async () => { rmSync(directory, { recursive: true, force: true }) })
    const hung = createServer(() => { /* Intentionally never respond. */ })
    await new Promise<void>((done) => hung.listen(0, '127.0.0.1', done))
    cleanup.push(async () => { hung.closeAllConnections(); await new Promise<void>((done) => hung.close(() => done())) })
    const port = (hung.address() as { port: number }).port
    writeFileSync(join(directory, 'config.json'), JSON.stringify({ server: `http://127.0.0.1:${port}`, token: 'private-timeout-token' }), { mode: 0o600 })
    const started = Date.now()
    const child = spawn(process.execPath, [bin, 'mcp', '--timeout', '100ms'], { env: { ...process.env, OWNGATE_CONFIG_DIR: directory }, stdio: 'pipe' })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const code = await new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('stdio bridge exceeded startup deadline')) }, 4000)
      child.once('close', (value) => { clearTimeout(timer); done(value) })
    })
    expect(code).toBe(1)
    expect(Date.now() - started).toBeLessThan(3500)
    expect(stdout).toBe('')
    expect(stderr).toContain('Cannot connect')
    expect(stderr).not.toContain('private-timeout-token')
  }, 10_000)
})
