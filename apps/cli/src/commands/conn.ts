import { Command } from 'commander'
import Table from 'cli-table3'
import { clearDefaultConnection, readConfig, writeConfig } from '../config.js'
import { listGrantedConnections, resolveConnection } from '../connections.js'
import type { GrantedConnection } from '../connections.js'
import { reportCliFailure } from '../diagnostics.js'
import { CliUsageError } from '../errors.js'

export { listGrantedConnections } from '../connections.js'
export type { GrantedConnection } from '../connections.js'

interface ListOptions { json?: boolean; verbose?: boolean }

async function listConnections(options: ListOptions): Promise<void> {
  try {
    const connections = await listGrantedConnections()
    if (options.json || !process.stdout.isTTY) {
      console.log(JSON.stringify({ connections }, null, 2))
      return
    }
    if (connections.length === 0) {
      console.log('暂无已授权连接。请在后台「客户端」中授予连接权限。')
      return
    }
    const defaultId = readConfig().defaultConnection
    const table = new Table({ head: ['名称', '连接器', '能力数', 'ID'], style: { head: ['cyan'] } })
    for (const connection of connections) {
      table.push([
        `${connection.label}${connection.id === defaultId ? ' *' : ''}`,
        connection.connector_id,
        connection.granted.includes('*') ? `全部查询${connection.granted.length > 1 ? ` + ${connection.granted.length - 1}` : ''}` : connection.granted.length,
        connection.id,
      ])
    }
    console.log(table.toString())
    if (connections.some((connection) => connection.id === defaultId)) console.log('* 默认连接')
  } catch (error) { process.exitCode = reportCliFailure(error, options.verbose) }
}

export function createConnCommand(): Command {
  const command = new Command('conn')
    .description('查看连接、设置默认连接；支持直接使用名称')
    .option('-j, --json', '输出 JSON（非终端时默认）')
    .option('-v, --verbose', '在 stderr 显示安全的技术诊断')
    .action((_options: ListOptions, actionCommand: Command) => listConnections(actionCommand.optsWithGlobals<ListOptions>()))
  command.command('ls').alias('list')
    .description('列出已授权连接；* 表示默认连接')
    .option('-j, --json', '输出 JSON（非终端时默认）')
    .option('-v, --verbose', '在 stderr 显示安全的技术诊断')
    .action((_options: ListOptions, actionCommand: Command) => listConnections(actionCommand.optsWithGlobals<ListOptions>()))
  command.command('use [connection]')
    .description('按名称、连接器或 ID 设置默认连接；省略参数查看当前值')
    .option('--clear', '清除默认连接')
    .option('-j, --json', '输出 JSON（非终端时默认）')
    .option('-v, --verbose', '在 stderr 显示安全的技术诊断')
    .action(async (selector: string | undefined, _options: ListOptions & { clear?: boolean }, actionCommand: Command) => {
      const options = actionCommand.optsWithGlobals<ListOptions & { clear?: boolean }>()
      try {
        if (selector !== undefined && options.clear) throw new CliUsageError('连接参数不能与 --clear 同时使用。', '运行 `owngate conn use <名称>` 选择连接，或 `owngate conn use --clear` 清除默认值。')
        let connection: GrantedConnection | null = null
        if (options.clear) clearDefaultConnection()
        else if (selector !== undefined) {
          connection = await resolveConnection(selector)
          writeConfig({ defaultConnection: connection.id })
        } else if (readConfig().defaultConnection) connection = await resolveConnection()
        if (options.json || !process.stdout.isTTY) console.log(JSON.stringify({ default_connection: connection }, null, 2))
        else if (connection) console.log(`默认连接：${connection.label} (${connection.connector_id}, ${connection.id})`)
        else console.log(options.clear ? '已清除默认连接。' : '未设置默认连接。运行 `owngate conn use <名称>` 选择。')
      } catch (error) { process.exitCode = reportCliFailure(error, options.verbose) }
    })
  return command
}
