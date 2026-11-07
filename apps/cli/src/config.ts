import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { CliUsageError } from './errors.js'
import { normalizeServerUrl, normalizeToken } from './prompt.js'

export interface Config { server: string; token: string; defaultConnection?: string }

function configDirectory(): string {
  const override = process.env['OWNGATE_CONFIG_DIR']
  return override ? resolve(override) : join(homedir(), '.owngate')
}

/** Read known configuration fields without requiring a completed login. */
export function readConfigValues(): Partial<Config> {
  const path = join(configDirectory(), 'config.json')
  if (!existsSync(path)) return {}
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) }
  catch { throw new CliUsageError('无法读取命令行配置。', '运行 `owngate login` 重新配置服务器与客户端令牌。') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const fields = value as Record<string, unknown>
  const config: Partial<Config> = {}
  for (const key of ['server', 'token', 'defaultConnection'] as const) {
    if (typeof fields[key] === 'string' && fields[key] !== '') config[key] = fields[key]
  }
  return config
}

export function readConfig(): Config {
  const value = readConfigValues()
  if (!value.server || !value.token) {
    throw new CliUsageError('尚未配置命令行登录。', '运行 `owngate login` 设置服务器地址与客户端令牌。')
  }
  return { server: normalizeServerUrl(value.server), token: normalizeToken(value.token), ...(value.defaultConnection ? { defaultConnection: value.defaultConnection } : {}) }
}

function saveConfig(config: Partial<Config>): void {
  const directory = configDirectory()
  const path = join(directory, 'config.json')
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.config-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function normalizedServer(value: string | undefined): string | undefined {
  if (!value) return undefined
  try { return new URL(value.trim()).href.replace(/\/+$/, '') }
  catch { return value.trim().replace(/\/+$/, '') }
}

export function writeConfig(config: Partial<Config>): void {
  let existing: Partial<Config>
  try { existing = readConfigValues() }
  catch (error) {
    if (!(error instanceof CliUsageError)) throw error
    existing = {}
  }
  const updated = { ...existing, ...config }
  if ((config.server !== undefined && normalizedServer(config.server) !== normalizedServer(existing.server)) ||
      (config.token !== undefined && config.token !== existing.token)) delete updated.defaultConnection
  saveConfig(updated)
}

export function clearDefaultConnection(): void {
  const config = readConfigValues()
  delete config.defaultConnection
  saveConfig(config)
}
