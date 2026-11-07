import { Command } from 'commander'
import Table from 'cli-table3'
import { apiCall } from '../http.js'
import { resolveConnection } from '../connections.js'
import type { GrantedConnection } from '../connections.js'
import { reportCliFailure } from '../diagnostics.js'
import { CliResponseError, CliUsageError } from '../errors.js'
import type { Capability } from '@owngate/core'

interface DisplayOptions { json?: boolean; verbose?: boolean }

async function loadCapabilities(connection: GrantedConnection): Promise<Capability[]> {
  const data = await apiCall(`/api/connections/${encodeURIComponent(connection.id)}/capabilities`)
  const capabilities = typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)['capabilities'] : undefined
  if (!Array.isArray(capabilities) || !capabilities.every((value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const item = value as Record<string, unknown>
    return typeof item['id'] === 'string' && typeof item['title'] === 'string'
      && ['query', 'action'].includes(String(item['kind']))
      && typeof item['input'] === 'object' && item['input'] !== null && !Array.isArray(item['input'])
  })) throw new CliResponseError('服务器未返回有效的能力列表。', '检查服务器地址及版本后重试，或运行 owngate status 检查连接。')
  return capabilities as Capability[]
}

async function listCapabilities(selector: string | undefined, options: DisplayOptions): Promise<void> {
  try {
    const connection = await resolveConnection(selector)
    const capabilities = await loadCapabilities(connection)
    if (options.json || !process.stdout.isTTY) {
      console.log(JSON.stringify({ capabilities }, null, 2))
      return
    }
    if (capabilities.length === 0) { console.log(`${connection.label} 暂无已授权能力。`); return }
    console.log(`${connection.label} (${connection.connector_id})`)
    const table = new Table({ head: ['ID', '名称', '类型', '状态'], style: { head: ['cyan'] } })
    for (const capability of capabilities) table.push([capability.id, capability.title, capability.kind, capability.support?.status ?? ''])
    console.log(table.toString())
    console.error('用 `owngate cap show [连接] <能力>` 查看参数与调用示例。')
  } catch (error) { process.exitCode = reportCliFailure(error, options.verbose) }
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function schemaType(schema: Record<string, unknown>): string {
  if (typeof schema['type'] === 'string') return schema['type']
  if (Array.isArray(schema['type'])) return schema['type'].join(' | ')
  if (Array.isArray(schema['enum'])) return 'enum'
  if (typeof schema['$ref'] === 'string') return schema['$ref']
  return 'any'
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

function exampleValue(schema: Record<string, unknown>): unknown {
  if (Object.hasOwn(schema, 'default')) return schema['default']
  if (Array.isArray(schema['enum']) && schema['enum'].length > 0) return schema['enum'][0]
  switch (schema['type']) {
    case 'integer': case 'number': return typeof schema['minimum'] === 'number' ? schema['minimum'] : 1
    case 'boolean': return true
    case 'array': return []
    case 'object': return {}
    default: return '<value>'
  }
}

function showCapability(connection: GrantedConnection, selector: string | undefined, capability: Capability): void {
  console.log(`${capability.title} (${capability.id})`)
  console.log(`连接：${connection.label} (${connection.connector_id}, ${connection.id})`)
  if (capability.description) console.log(capability.description)
  console.log(`类型：${capability.kind} · 影响：${capability.effect} · 状态：${capability.support?.status ?? 'unknown'}${capability.support?.reason ? ` — ${capability.support.reason}` : ''}`)
  const properties = object(capability.input['properties'])
  const required = new Set(Array.isArray(capability.input['required']) ? capability.input['required'] : [])
  if (Object.keys(properties).length === 0) console.log('\n无需输入参数。')
  else {
    const available = Math.max(74, (process.stdout.columns || 100) - 6)
    const choicesWidth = Math.floor((available - 36) * 0.55)
    const table = new Table({
      head: ['参数', '必填', '类型', '默认值 / 可选值', '说明'],
      colWidths: [18, 6, 12, choicesWidth, available - 36 - choicesWidth],
      style: { head: ['cyan'] }, wordWrap: true,
    })
    for (const [name, value] of Object.entries(properties)) {
      const schema = object(value)
      const defaults = Object.hasOwn(schema, 'default') ? `默认：${JSON.stringify(schema['default'])}` : ''
      const choices = Array.isArray(schema['enum']) ? `可选：${schema['enum'].map((item) => JSON.stringify(item)).join(', ')}` : ''
      const description = typeof schema['description'] === 'string' ? schema['description'] : typeof schema['title'] === 'string' ? schema['title'] : ''
      table.push([name, required.has(name) ? '是' : '否', schemaType(schema), [defaults, choices].filter(Boolean).join('\n'), description])
    }
    console.log(`\n${table.toString()}`)
  }
  const example = ['owngate', capability.kind === 'action' ? 'action propose' : 'query', ...(selector ? [shellQuote(selector)] : []), shellQuote(capability.id)]
  if (capability.kind === 'action' && !selector) example.splice(2, 0, shellQuote(`id:${connection.id}`))
  const input = Object.fromEntries([...required].filter((name): name is string => typeof name === 'string').map((name) => [name, exampleValue(object(properties[name]))]))
  if (Object.keys(input).length > 0) example.push('--input', shellQuote(JSON.stringify(input)))
  console.log(`\n示例：${example.join(' ')}`)
}

export function createCapCommand(): Command {
  const command = new Command('cap')
    .description('查看已授权能力、参数与调用示例')
    .argument('[connection]', '连接名称、连接器或 ID；省略使用默认连接')
    .option('-j, --json', '输出 JSON（非终端时默认）')
    .option('-v, --verbose', '在 stderr 显示安全的技术诊断')
    .action((selector: string | undefined, _options: DisplayOptions, actionCommand: Command) => listCapabilities(selector, actionCommand.optsWithGlobals<DisplayOptions>()))
  command.command('ls [connection]').alias('list')
    .description('列出能力；省略连接使用默认值')
    .option('-j, --json', '输出 JSON（非终端时默认）')
    .option('-v, --verbose', '在 stderr 显示安全的技术诊断')
    .action((selector: string | undefined, _options: DisplayOptions, actionCommand: Command) => listCapabilities(selector, actionCommand.optsWithGlobals<DisplayOptions>()))
  command.command('show [connection] [capability]')
    .description('查看参数与输入输出结构；单个参数视为默认连接的能力')
    .option('-j, --json', '输出完整能力 Schema')
    .option('-v, --verbose', '在 stderr 显示安全的技术诊断')
    .action(async (selector: string | undefined, capabilityId: string | undefined, _options: DisplayOptions, actionCommand: Command) => {
      const options = actionCommand.optsWithGlobals<DisplayOptions>()
      try {
        if (capabilityId === undefined) { capabilityId = selector; selector = undefined }
        if (!capabilityId?.trim()) throw new CliUsageError('请指定能力。', '运行 `owngate cap show [连接] <能力>` 查看详情，或用 `owngate cap ls [连接]` 查看能力列表。')
        const connection = await resolveConnection(selector)
        const capabilities = await loadCapabilities(connection)
        const capability = capabilities.find((item) => item.id === capabilityId)
        if (!capability) throw new CliUsageError(`连接 ${JSON.stringify(connection.label)} 未授权能力 ${JSON.stringify(capabilityId)}。`, '运行 `owngate cap ls [连接]` 查看该连接的已授权能力。')
        if (options.json || !process.stdout.isTTY) console.log(JSON.stringify(capability, null, 2))
        else showCapability(connection, selector, capability)
      } catch (error) { process.exitCode = reportCliFailure(error, options.verbose) }
    })
  return command
}
