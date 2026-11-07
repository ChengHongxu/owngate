import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import type { Capability } from '@owngate/core'
import { clearDefaultConnection, readConfig, readConfigValues, writeConfig } from '../src/config.js'
import { ConnectionSelectionError, resolveConnection } from '../src/connections.js'
import type { GrantedConnection } from '../src/connections.js'
import { createConnCommand } from '../src/commands/conn.js'
import { createCapCommand } from '../src/commands/cap.js'
import { CliUsageError } from '../src/errors.js'

let directory: string
let connections: GrantedConnection[]
let capabilities: Capability[]
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
const aff = { id: 'abcd111122223333', connector_id: 'newapi', label: 'AFF', granted: ['account.balance', 'model.list'] }
const bili = { id: 'bbbb111122223333', connector_id: 'bilibili', label: 'B站', granted: ['feed.list'] }
const capability: Capability = {
  id: 'feed.list', title: 'Feed', description: 'Read the authorized feed.', kind: 'query', effect: 'read', approval: 'never',
  input: { type: 'object', required: ['source'], properties: {
    source: { type: 'string', enum: ["friend's feed", 'recommended'], description: 'Feed source' },
    limit: { type: 'integer', default: 10 },
    active: { type: 'boolean', default: false },
  } },
  output: { type: 'object', properties: { items: { type: 'array' } } }, cache: null, long_running: false,
  cancel: 'none', idempotency: 'none', verify: null, transport: 'http', support: { status: 'supported' },
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'owngate-cli-connections-'))
  vi.stubEnv('OWNGATE_CONFIG_DIR', directory)
  writeConfig({ server: 'http://fixture.invalid', token: 'fixture-client-token' })
  connections = [structuredClone(aff), structuredClone(bili)]
  capabilities = [structuredClone(capability)]
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const pathname = new URL(url).pathname
    if (pathname === '/api/connections') return new Response(JSON.stringify({ connections }))
    if (pathname.endsWith('/capabilities')) return new Response(JSON.stringify({ capabilities }))
    throw new Error('Unexpected fixture endpoint')
  }))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  process.exitCode = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY)
  else Reflect.deleteProperty(process.stdout, 'isTTY')
  process.exitCode = 0
  rmSync(directory, { recursive: true, force: true })
})

async function run(...args: string[]): Promise<void> {
  await new Command('owngate').exitOverride().addCommand(createConnCommand()).addCommand(createCapCommand()).parseAsync(['node', 'owngate', ...args])
}

function output(): string { return vi.mocked(console.log).mock.calls.map((call) => String(call[0])).join('\n') }

function assertReadOnly(): void {
  for (const call of vi.mocked(fetch).mock.calls) expect(call[1]?.method).toBe('GET')
}

describe('connection selectors', () => {
  it.each(['AFF', 'aff', 'AfF', 'newapi', 'NEWAPI', aff.id, 'abcd'])('resolves %s without a local alias cache', async (selector) => {
    expect(await resolveConnection(selector)).toEqual(aff)
    expect(fetch).toHaveBeenCalledOnce()
    assertReadOnly()
  })

  it('prefers an exact ID to a matching label, and supports explicit selector forms', async () => {
    const other = { ...bili, label: aff.id }
    connections = [aff, other]
    expect((await resolveConnection(aff.id)).id).toBe(aff.id)
    expect((await resolveConnection(`name:${aff.id}`)).id).toBe(other.id)
    expect((await resolveConnection(`id:${aff.id}`)).id).toBe(aff.id)
  })

  it('prefers a unique label to a connector, with an explicit connector escape', async () => {
    connections = [aff, { ...bili, label: 'newapi' }]
    expect((await resolveConnection('newapi')).id).toBe(bili.id)
    expect((await resolveConnection('connector:newapi')).id).toBe(aff.id)
  })

  it.each(['AFF', 'aff', 'name:AFF'])('rejects a case-insensitive duplicate label even with an exact-case match: %s', async (selector) => {
    connections = [aff, { ...bili, label: 'aff' }]
    await expect(resolveConnection(selector)).rejects.toBeInstanceOf(ConnectionSelectionError)
    assertReadOnly()
  })

  it('rejects an ambiguous connector or ID prefix instead of choosing the first row', async () => {
    connections = [aff, { ...bili, id: 'abcd999922223333', connector_id: 'newapi' }]
    await expect(resolveConnection('newapi')).rejects.toThrow('多个')
    await expect(resolveConnection('connector:newapi')).rejects.toThrow('多个')
    await expect(resolveConnection('abcd')).rejects.toThrow('多个')
    expect((await resolveConnection('abcd1')).id).toBe(aff.id)
    assertReadOnly()
  })

  it.each(['abc', 'AF', 'id:abcd', 'missing'])('does not accept an unsafe short prefix, partial label, or unknown connection: %s', async (selector) => {
    await expect(resolveConnection(selector)).rejects.toBeInstanceOf(ConnectionSelectionError)
    assertReadOnly()
  })

  it('refreshes authorized names on every resolution', async () => {
    expect((await resolveConnection('AFF')).id).toBe(aff.id)
    connections = [bili]
    await expect(resolveConnection('AFF')).rejects.toThrow('已授权连接')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('requires an explicit choice for several connections and uses a sole connection automatically', async () => {
    await expect(resolveConnection()).rejects.toThrow('多个连接')
    connections = [bili]
    expect(await resolveConnection()).toEqual(bili)
    expect(readConfig().defaultConnection).toBeUndefined()
  })

  it('uses a saved ID through renames and rejects a revoked default without falling back', async () => {
    writeConfig({ defaultConnection: aff.id })
    connections = [{ ...aff, label: 'Renamed' }, bili]
    expect((await resolveConnection()).id).toBe(aff.id)
    connections = [bili]
    await expect(resolveConnection()).rejects.toThrow('默认连接已不存在或未授权')
    expect(readConfig().defaultConnection).toBe(aff.id)
    connections = []
    await expect(resolveConnection()).rejects.toThrow('默认连接已不存在或未授权')
    assertReadOnly()
  })

  it('explains an empty authorization scope', async () => {
    connections = []
    await expect(resolveConnection('AFF')).rejects.toMatchObject({ nextStep: expect.stringContaining('后台「客户端」') })
    await expect(resolveConnection()).rejects.toThrow('尚未获准访问任何连接')
    assertReadOnly()
  })
})

describe('default connection configuration', () => {
  it('reads legacy config, filters unknown fields, and keeps the file private', () => {
    expect(readConfig()).toEqual({ server: 'http://fixture.invalid', token: 'fixture-client-token' })
    writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...readConfig(), ignored: 'value', defaultConnection: 10 }))
    expect(readConfigValues()).not.toHaveProperty('ignored')
    expect(readConfigValues()).not.toHaveProperty('defaultConnection')
    writeConfig({ defaultConnection: aff.id })
    expect(statSync(join(directory, 'config.json')).mode & 0o777).toBe(0o600)
  })

  it('preserves a default for the same credentials and clears it when either scope changes', () => {
    writeConfig({ defaultConnection: aff.id })
    writeConfig({ server: 'http://fixture.invalid/', token: 'fixture-client-token' })
    expect(readConfig().defaultConnection).toBe(aff.id)
    writeConfig({ token: 'another-fixture-token' })
    expect(readConfig().defaultConnection).toBeUndefined()
    writeConfig({ defaultConnection: aff.id })
    writeConfig({ server: 'http://different.invalid' })
    expect(readConfig().defaultConnection).toBeUndefined()
  })

  it('removes only the default field', () => {
    writeConfig({ defaultConnection: aff.id })
    clearDefaultConnection()
    expect(readConfig()).toEqual({ server: 'http://fixture.invalid', token: 'fixture-client-token' })
    expect(JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))).not.toHaveProperty('defaultConnection')
  })

  it('allows configuration inspection before login and returns safe errors for unreadable config', () => {
    rmSync(join(directory, 'config.json'))
    expect(readConfigValues()).toEqual({})
    expect(() => readConfig()).toThrow(CliUsageError)
    writeFileSync(join(directory, 'config.json'), '{"token":"fixture-private-value",bad')
    expect(() => readConfig()).toThrow('无法读取命令行配置')
    try { readConfig() } catch (error) { expect(String(error)).not.toContain('fixture-private-value') }
    writeConfig({ server: 'http://fixture.invalid', token: 'repaired-fixture-token' })
    expect(readConfig().token).toBe('repaired-fixture-token')
  })

  it.each([
    { server: 'http://user:private-fixture@fixture.invalid', token: 'fixture-token' },
    { server: 'http://fixture.invalid?secret=private-fixture', token: 'fixture-token' },
    { server: 'http://fixture.invalid', token: 'private-fixture\ninjected-header' },
  ])('rejects unsafe values in historical configuration without repeating them', (config) => {
    writeConfig(config)
    expect(() => readConfig()).toThrow(CliUsageError)
    try { readConfig() } catch (error) { expect(String(error)).not.toContain('private-fixture') }
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('connection and capability discovery output', () => {
  it('keeps REST item shapes in JSON and shows counts instead of long grant lists in a TTY', async () => {
    await run('conn')
    expect(JSON.parse(output())).toEqual({ connections })
    vi.mocked(console.log).mockClear()
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
    writeConfig({ defaultConnection: aff.id })
    await run('conn', 'ls')
    expect(output()).toContain('AFF *')
    expect(output()).toContain(aff.id)
    expect(output()).not.toContain('account.balance')
  })

  it('saves a validated ID, keeps it unchanged after an ambiguous request, and clears it explicitly', async () => {
    await run('conn', 'use', 'AFF')
    expect(readConfig().defaultConnection).toBe(aff.id)
    expect(JSON.parse(output()).default_connection).toEqual(aff)
    connections = [aff, { ...bili, label: 'aff' }]
    await run('conn', 'use', 'AFF')
    expect(process.exitCode).toBe(2)
    expect(readConfig().defaultConnection).toBe(aff.id)
    await run('conn', 'use', '--clear')
    expect(readConfig().defaultConnection).toBeUndefined()
    assertReadOnly()
  })

  it('rejects conflicting default options before making a request or changing config', async () => {
    await run('conn', 'use', 'AFF', '--clear')
    expect(process.exitCode).toBe(2)
    expect(fetch).not.toHaveBeenCalled()
    expect(readConfig().defaultConnection).toBeUndefined()
  })

  it('honors flags before discovery subcommands and does not retain them in a new command', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
    await run('conn', '--json', 'ls')
    expect(JSON.parse(output())).toEqual({ connections })
    vi.mocked(console.log).mockClear()
    await run('conn', 'ls')
    expect(output()).toContain('能力数')
    vi.mocked(console.log).mockClear()
    await run('cap', '--json', 'ls', 'AFF')
    expect(JSON.parse(output())).toEqual({ capabilities })
  })

  it('encodes resolved IDs in capability paths and shows the full input/output schema', async () => {
    connections = [{ ...aff, id: 'fixture/id?query=value' }]
    await run('cap', 'show', 'AFF', 'feed.list', '--json')
    expect(JSON.parse(output())).toEqual(capability)
    expect(vi.mocked(fetch).mock.calls[1]![0]).toContain('/fixture%2Fid%3Fquery%3Dvalue/capabilities')
    assertReadOnly()
  })

  it('shows schema-derived required, type, defaults, choices, and a shell-safe example in a TTY', async () => {
    connections = [aff]
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
    await run('cap', 'show', "name:AFF", 'feed.list')
    expect(output()).toContain('必填')
    expect(output()).toContain('默认：false')
    expect(output()).toContain('可选：')
    expect(output()).toContain("owngate query 'name:AFF' 'feed.list' --input")
    expect(output()).toContain("friend'\\''s feed")
  })
})
