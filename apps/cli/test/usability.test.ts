import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const bin = resolve(root, 'apps/cli/dist/bin.js')
const cleanup: Array<() => Promise<void>> = []

// These process tests deliberately do not rebuild dist while other CLI tests
// are running. Build @owngate/cli before running this file independently.
beforeAll(() => {
  if (!existsSync(bin)) throw new Error('Build @owngate/cli before running the CLI usability process tests.')
})

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

interface Connection {
  id: string
  connector_id: string
  label: string
  granted: string[]
}

interface Request {
  method: string
  url: string
  body: Record<string, unknown>
  authorized: boolean
}

interface CliResult { code: number | null; stdout: string; stderr: string }

const aff: Connection = {
  id: 'conn-aff-01234567', connector_id: 'newapi', label: 'AFF',
  granted: ['account.balance', 'feed.list', 'message.send'],
}
const bilibili: Connection = {
  id: 'conn-bili-89abcdef', connector_id: 'bilibili', label: 'B站',
  granted: ['account.balance', 'feed.list'],
}
const balanceCapability = {
  id: 'account.balance', kind: 'query', title: '账户余额', description: '读取本地测试账户余额',
  effect: 'read', approval: 'none', transport: 'http', support: { status: 'supported' },
  input: {
    type: 'object', additionalProperties: false, required: ['currency'],
    properties: {
      currency: { type: 'string', enum: ['CNY', 'USD'], description: '货币' },
      limit: { type: 'integer', default: 10, minimum: 1, maximum: 100 },
    },
  },
  output: { type: 'object', properties: { balance: { type: 'number' } } },
  cache: { ttl: 60 }, long_running: false, cancel: 'none', idempotency: 'none', verify: null,
}

function envelope(connectionId: string, capabilityId = 'account.balance') {
  return {
    envelope_version: 2, status: 'ok', outcome: 'success', data: { balance: 12.5 }, error: null,
    source: {
      connection_id: connectionId, connection_label: connectionId === aff.id ? aff.label : bilibili.label,
      capability_id: capabilityId, support: { status: 'supported' },
    },
    fields: {}, queried_at: '2026-11-04T00:00:00.000Z', data_time: '2026-11-04T00:00:00.000Z',
    cache: null, warnings: [],
  }
}

async function fixture(initialConnections: Connection[] = [aff, bilibili]) {
  const directory = mkdtempSync(join(tmpdir(), 'owngate-cli-usability-'))
  cleanup.push(async () => { rmSync(directory, { recursive: true, force: true }) })
  const token = 'usability-fixture-token-never-print'
  let connections = initialConnections
  const requests: Request[] = []
  const server = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += String(chunk)
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>
    const url = request.url ?? ''
    const authorized = request.headers.authorization === `Bearer ${token}`
    requests.push({ method: request.method ?? '', url, body, authorized })
    response.setHeader('Content-Type', 'application/json')
    const send = (value: unknown, status = 200) => {
      response.statusCode = status
      response.end(JSON.stringify(value))
    }
    if (!authorized) return send({ error: { code: 'UNAUTHENTICATED', message: 'Fixture token rejected', retryable: false } }, 401)
    if (request.method === 'GET' && url === '/api/connections') return send({ connections })
    if (request.method === 'GET' && url === '/api/session') return send({ id: 'fixture-client', label: 'Fixture client' })
    const capabilities = /^\/api\/connections\/([^/]+)\/capabilities$/.exec(url)
    if (request.method === 'GET' && capabilities) {
      const id = decodeURIComponent(capabilities[1]!)
      if (!connections.some((connection) => connection.id === id)) {
        return send({ error: { code: 'CONNECTION_NOT_FOUND', message: 'Fixture connection unavailable', retryable: false } }, 404)
      }
      return send({ connection_id: id, capabilities: [balanceCapability] })
    }
    if (request.method === 'POST' && url === '/api/invoke') {
      return send(envelope(String(body['connection_id']), String(body['capability_id'])))
    }
    if (request.method === 'POST' && (url === '/api/query' || url === '/api/feed')) {
      return send({ envelope_version: 2, status: 'ok', results: [], ...(url === '/api/feed' ? { items: [] } : {}) })
    }
    if (request.method === 'POST' && url === '/api/proposals') {
      return send({ id: 'proposal-fixture', status: 'pending', ...body })
    }
    return send({ error: { code: 'NOT_FOUND', message: 'Unexpected fixture route' } }, 404)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()))
  })
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ server: address, token }), { mode: 0o600 })

  const run = (args: string[], input = ''): Promise<CliResult> => new Promise((done, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: root,
      env: { ...process.env, OWNGATE_CONFIG_DIR: directory, OWNGATE_TIMEOUT_MS: '1500', NO_COLOR: '1' },
      stdio: 'pipe',
    })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('CLI usability process exceeded its 5s deadline'))
    }, 5000)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr }) })
    child.stdin.end(input)
  })

  return {
    address, directory, token, requests, run,
    setConnections(value: Connection[]) { connections = value },
    posts: () => requests.filter((request) => request.method === 'POST'),
    config: () => JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8')) as Record<string, unknown>,
  }
}

describe('spawned CLI usability with isolated loopback fixtures', () => {
  it('shows root help successfully without internal Commander messages or a server request', async () => {
    const f = await fixture()
    const result = await f.run([])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('owngate')
    expect(result.stdout).toContain('query')
    expect(result.stdout + result.stderr).not.toContain('(outputHelp)')
    expect(result.stderr).toBe('')
    expect(f.requests).toEqual([])
  })

  it('reports unknown commands and options once, with usage exit code 2', async () => {
    const f = await fixture()
    for (const args of [['not-a-command'], ['conn', '--not-an-option']]) {
      const result = await f.run(args)
      const invalid = args.at(-1)!
      expect(result.code).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr.split(invalid)).toHaveLength(2)
      expect(result.stderr).not.toContain('(outputHelp)')
    }
    expect(f.requests).toEqual([])
  })

  it('uses bare conn and cap as pipe-friendly discovery commands', async () => {
    const f = await fixture()
    const connectionList = await f.run(['conn'])
    expect(connectionList.code).toBe(0)
    expect(JSON.parse(connectionList.stdout)).toEqual({ connections: [aff, bilibili] })
    expect(connectionList.stderr).toBe('')
    expect((await f.run(['conn', 'use', 'AFF'])).code).toBe(0)
    const capabilityList = await f.run(['cap'])
    expect(capabilityList.code).toBe(0)
    expect(JSON.parse(capabilityList.stdout)).toMatchObject({ capabilities: [balanceCapability] })
    expect(capabilityList.stderr).toBe('')
    expect(f.requests.some((request) => request.url === `/api/connections/${aff.id}/capabilities`)).toBe(true)
  })

  it('saves a resolved default and invokes it with typed parameters when the selector is omitted', async () => {
    const f = await fixture()
    const selected = await f.run(['conn', 'use', 'AFF'])
    expect(selected.code).toBe(0)
    expect(f.config()['defaultConnection']).toBe(aff.id)
    const result = await f.run(['query', 'account.balance', '--param', 'currency=CNY', '--param', 'limit=5'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'ok', source: { connection_id: aff.id } })
    expect(result.stderr).toBe('')
    expect(f.posts()).toEqual([expect.objectContaining({
      url: '/api/invoke', body: expect.objectContaining({ connection_id: aff.id, capability_id: 'account.balance', input: { currency: 'CNY', limit: 5 } }),
    })])
    expect(f.requests.filter((request) => request.url === '/api/connections')).toHaveLength(2)
  })

  it('resolves names, case, connector type, ID prefixes and explicit selector kinds to the same actual ID', async () => {
    const f = await fixture()
    for (const selector of ['AFF', 'aff', 'newapi', 'conn-aff', aff.id, 'name:AFF', 'connector:newapi', `id:${aff.id}`]) {
      const result = await f.run(['query', selector, 'account.balance'])
      expect(result.code, selector).toBe(0)
      expect(JSON.parse(result.stdout).source.connection_id, selector).toBe(aff.id)
      expect(f.posts().at(-1)?.body['connection_id'], selector).toBe(aff.id)
    }
    expect(f.posts()).toHaveLength(8)
  }, 15_000)

  it('rejects ambiguous names, connector types and prefixes before submitting anything', async () => {
    const other = { ...aff, id: 'conn-aff-fedcba98' }
    const f = await fixture([aff, other, bilibili])
    for (const selector of ['AFF', 'newapi', 'conn-aff', 'unknown-connection']) {
      const result = await f.run(['query', selector, 'account.balance'])
      expect(result.code, selector).toBe(2)
      expect(result.stdout, selector).toBe('')
      expect(result.stderr.length, selector).toBeGreaterThan(0)
    }
    expect(f.posts()).toEqual([])
  }, 10_000)

  it('selects a sole granted connection but never silently replaces an unavailable saved default', async () => {
    const f = await fixture()
    const missing = await f.run(['query', 'account.balance'])
    expect(missing.code).toBe(2)
    expect(f.posts()).toEqual([])
    f.setConnections([aff])
    expect((await f.run(['query', 'account.balance'])).code).toBe(0)
    expect(f.posts().at(-1)?.body['connection_id']).toBe(aff.id)
    expect((await f.run(['conn', 'use', 'AFF'])).code).toBe(0)
    f.setConnections([bilibili])
    const before = f.posts().length
    const stale = await f.run(['query', 'account.balance'])
    expect(stale.code).toBe(2)
    expect(stale.stdout).toBe('')
    expect(f.posts()).toHaveLength(before)
    expect((await f.run(['conn', 'use', '--clear'])).code).toBe(0)
    expect((await f.run(['query', 'account.balance'])).code).toBe(0)
    expect(f.posts().at(-1)?.body['connection_id']).toBe(bilibili.id)
  }, 15_000)

  it('exposes the complete input schema through cap show using a name or saved default', async () => {
    const f = await fixture()
    const explicit = await f.run(['cap', 'show', 'AFF', 'account.balance'])
    expect(explicit.code).toBe(0)
    expect(JSON.parse(explicit.stdout)).toEqual(balanceCapability)
    expect((await f.run(['conn', 'use', 'AFF'])).code).toBe(0)
    const implicit = await f.run(['cap', 'show', 'account.balance'])
    expect(implicit.code).toBe(0)
    expect(JSON.parse(implicit.stdout)).toEqual(balanceCapability)
    expect(implicit.stderr).toBe('')
    expect(f.posts()).toEqual([])
  })

  it('distinguishes the default feed, explicit connection and deliberate all-connection aggregation', async () => {
    const f = await fixture()
    expect((await f.run(['feed'])).code).toBe(2)
    expect(f.posts()).toEqual([])
    expect((await f.run(['conn', 'use', 'AFF'])).code).toBe(0)
    const current = await f.run(['feed', '--since', '6h', '--limit', '3'])
    expect(current.code).toBe(0)
    expect(JSON.parse(current.stdout)).toMatchObject({ status: 'ok' })
    expect(f.posts().at(-1)).toMatchObject({
      url: '/api/feed', body: { connection_ids: [aff.id], since: '6h', input: { limit: 3 } },
    })
    const explicit = await f.run(['feed', '--connection', 'bilibili'])
    expect(explicit.code).toBe(0)
    expect(f.posts().at(-1)?.body['connection_ids']).toEqual([bilibili.id])
    const all = await f.run(['feed', '--all'])
    expect(all.code).toBe(0)
    expect(f.posts().at(-1)?.url).toBe('/api/feed')
    expect(f.posts().at(-1)?.body).not.toHaveProperty('connection_ids')
    expect(f.posts()).toHaveLength(3)
  })

  it('rejects conflicting query and feed selection modes without any POST', async () => {
    const f = await fixture()
    const cases = [
      ['query', 'AFF', 'account.balance', '--all'],
      ['query', 'AFF', 'account.balance', '--tag', 'team'],
      ['query', 'account.balance', '--all', '--tag', 'team'],
      ['query', 'account.balance', '--all', '--async'],
      ['feed', '--all', '--connection', 'AFF'],
    ]
    for (const args of cases) {
      const result = await f.run(args)
      expect(result.code, args.join(' ')).toBe(2)
      expect(result.stdout, args.join(' ')).toBe('')
      expect(result.stderr.length, args.join(' ')).toBeGreaterThan(0)
    }
    expect(f.posts()).toEqual([])
  }, 10_000)

  it('resolves an action proposal name and preserves the needs-approval exit code 5', async () => {
    const f = await fixture()
    const result = await f.run(['action', 'propose', 'AFF', 'message.send', '--input', '{"text":"fixture only"}'])
    expect(result.code).toBe(5)
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 'proposal-fixture', status: 'pending' })
    expect(result.stderr).toBe('')
    expect(f.posts()).toEqual([expect.objectContaining({
      url: '/api/proposals', body: { connection_id: aff.id, capability_id: 'message.send', input: { text: 'fixture only' } },
    })])
  })

  it('accepts a token on stdin, authenticates before saving, and never prints the token', async () => {
    const f = await fixture()
    const result = await f.run(['login', '--server', f.address, '--token-stdin'], `${f.token}\n`)
    expect(result.code).toBe(0)
    expect(result.stdout + result.stderr).not.toContain(f.token)
    expect(f.requests).toEqual([expect.objectContaining({ method: 'GET', url: '/api/connections', authorized: true })])
    expect(f.config()).toMatchObject({ server: f.address, token: f.token })
    expect(statSync(join(f.directory, 'config.json')).mode & 0o777).toBe(0o600)
    expect(statSync(f.directory).mode & 0o777).toBe(0o700)
    const rejected = await f.run(['login', '--server', f.address, '--token-stdin'], 'rejected-fixture-token\n')
    expect(rejected.code).not.toBe(0)
    expect(rejected.stdout + rejected.stderr).not.toContain('rejected-fixture-token')
    expect(f.config()).toMatchObject({ server: f.address, token: f.token })
  })
})
