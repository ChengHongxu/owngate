import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConfig, readConfigValues, writeConfig } from '../src/config.js'

// All default-directory tests use a synthetic home, including reads before login.
const fixtureHome = vi.hoisted(() => ({ path: '' }))
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => fixtureHome.path,
}))

let directory: string
const config = { server: 'https://fixture.invalid', token: 'fixture-token' }

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'owngate-config-'))
  fixtureHome.path = directory
  vi.stubEnv('OWNGATE_CONFIG_DIR', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

function seed(name: string, value: unknown): string {
  const destination = join(directory, name)
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  const path = join(destination, 'config.json')
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
  return path
}

describe('CLI configuration location', () => {
  it('reports an unconfigured login without creating a default directory', () => {
    expect(readConfigValues()).toEqual({})
    expect(() => readConfig()).toThrow('尚未配置')
    expect(existsSync(join(directory, '.owngate'))).toBe(false)
  })

  it('saves and reads a private login in the default directory without leaving temporary files', () => {
    writeConfig(config)
    writeConfig({ defaultConnection: 'fixture-connection' })
    const destination = join(directory, '.owngate')
    const path = join(destination, 'config.json')
    expect(readConfig()).toEqual({ ...config, defaultConnection: 'fixture-connection' })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(readConfig())
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(destination).mode & 0o777).toBe(0o700)
    expect(readdirSync(destination)).toEqual(['config.json'])
  })

  it('uses an explicit directory for both reading and writing', () => {
    const defaultPath = seed('.owngate', config)
    const defaultContents = readFileSync(defaultPath, 'utf8')
    vi.stubEnv('OWNGATE_CONFIG_DIR', join(directory, 'explicit'))
    writeConfig({ server: 'https://another.invalid', token: 'fixture-another-token' })
    expect(readConfig()).toEqual({ server: 'https://another.invalid', token: 'fixture-another-token' })
    expect(readFileSync(defaultPath, 'utf8')).toBe(defaultContents)
    expect(statSync(join(directory, 'explicit', 'config.json')).mode & 0o777).toBe(0o600)
  })

  it('requires a login for an empty explicit directory even when the home login exists', () => {
    seed('.owngate', config)
    vi.stubEnv('OWNGATE_CONFIG_DIR', join(directory, 'not-created'))
    expect(readConfigValues()).toEqual({})
    expect(() => readConfig()).toThrow('尚未配置')
  })
})
