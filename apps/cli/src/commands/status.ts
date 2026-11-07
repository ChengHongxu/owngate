import { Command } from 'commander'
import { readConfig } from '../config.js'
import { listGrantedConnections } from '../connections.js'
import { reportCliFailure } from '../diagnostics.js'

export function createStatusCommand(): Command {
  return new Command('status')
    .description('检查当前服务器、授权和默认连接；不显示令牌')
    .option('-j, --json', '输出 JSON（非终端默认）')
    .option('-v, --verbose', '在 stderr 显示技术诊断')
    .action(async (options: { json?: boolean; verbose?: boolean }) => {
      try {
        const config = readConfig()
        const connections = await listGrantedConnections()
        const selected = connections.find(connection => connection.id === config.defaultConnection)
        const result = {
          server: config.server,
          authenticated: true,
          connections: connections.length,
          default_connection: config.defaultConnection ? { id: config.defaultConnection, label: selected?.label ?? null, available: Boolean(selected) } : null,
        }
        if (options.json || !process.stdout.isTTY) console.log(JSON.stringify(result, null, 2))
        else {
          console.log(`服务器  ${result.server}`)
          console.log(`授权    ${connections.length} 个连接`)
          console.log(`默认    ${selected?.label ?? (config.defaultConnection ? '已失效' : '未设置')}`)
        }
        if (!connections.length) console.error('请在 Web 后台「客户端」中为当前客户端分配连接权限。')
        if (config.defaultConnection && !selected) console.error('默认连接已不可用；运行 owngate conn use <连接名称> 重新选择，或 conn use --clear 清除。')
      } catch (error) { process.exitCode = reportCliFailure(error, options.verbose) }
    })
}
