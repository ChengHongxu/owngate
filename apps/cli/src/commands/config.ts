import { Command } from 'commander'
import { readConfigValues, writeConfig } from '../config.js'
import { reportCliFailure } from '../diagnostics.js'
import { CliUsageError } from '../errors.js'
import { normalizeServerUrl, normalizeToken } from '../prompt.js'

function reportSaveFailure(error: unknown): void {
  if (error instanceof CliUsageError) process.exitCode = reportCliFailure(error)
  else {
    console.error('无法保存 CLI 配置。')
    console.error('检查配置目录的写入权限后重试。')
    process.exitCode = 1
  }
}

export function createConfigCommand(): Command {
  const command = new Command('config').description('查看或修改本地配置')
  command.command('show')
    .description('查看服务器、默认连接与令牌配置状态')
    .option('--json', '输出 JSON')
    .action((options: { json?: boolean }) => {
      try {
        const values = readConfigValues()
        let server: string | null = null
        try { if (values.server) server = normalizeServerUrl(values.server) } catch { /* Never echo legacy URLs containing credentials. */ }
        const summary = { server, default_connection: values.defaultConnection ?? null, token_configured: Boolean(values.token) }
        if (options.json || !process.stdout.isTTY) console.log(JSON.stringify(summary, null, 2))
        else {
          console.log(`服务器    ${summary.server ?? '未配置或地址无效'}`)
          console.log(`默认连接  ${summary.default_connection ?? '未设置'}`)
          console.log(`客户端令牌  ${summary.token_configured ? '已配置' : '未配置'}`)
        }
      } catch {
        console.error('无法读取 CLI 配置。')
        console.error('检查配置文件，或重新运行 owngate login。')
        process.exitCode = 1
      }
    })

  const set = command.command('set').description('修改服务器地址或客户端令牌')
  set.command('server <url>')
    .description('设置 HTTP(S) 服务器地址')
    .action((url: string) => {
      try {
        writeConfig({ server: normalizeServerUrl(url) })
        console.error('服务器地址已保存。')
      } catch (error) { reportSaveFailure(error) }
    })
  set.command('token <token>')
    .description('保存客户端令牌；推荐使用 login 验证后保存')
    .action((token: string) => {
      try {
        writeConfig({ token: normalizeToken(token) })
        console.error('客户端令牌已保存。')
        if (process.stdout.isTTY) console.error('运行 owngate status 检查权限；下次可用 login --server <url> --token-stdin 验证后保存。')
      } catch (error) { reportSaveFailure(error) }
    })
  return command
}
