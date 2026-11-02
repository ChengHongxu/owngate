import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  server: string
  token: string
}

const configDir = join(homedir(), '.webridge')
const configPath = join(configDir, 'config.json')

export function readConfig(): Config {
  if (!existsSync(configPath)) {
    console.error('No config found. Run `webridge login` to get started.')
    process.exit(1)
  }
  const raw = readFileSync(configPath, 'utf8')
  return JSON.parse(raw) as Config
}

export function writeConfig(config: Partial<Config>): void {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 })
  }
  const existing: Partial<Config> = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, 'utf8')) as Partial<Config>)
    : {}
  const merged = { ...existing, ...config }
  writeFileSync(configPath, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 })
}
