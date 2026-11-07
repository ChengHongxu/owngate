import { Command, Option } from 'commander'
import { writeConfig } from '../config.js'
import { reportCliFailure } from '../diagnostics.js'
import { CliUsageError } from '../errors.js'
import { apiCall } from '../http.js'
import { normalizeServerUrl, normalizeToken, promptInput, readTokenFromStdin } from '../prompt.js'

interface LoginOptions { server?: string; token?: string; tokenStdin?: boolean; verbose?: boolean }

export function createLoginCommand(): Command {
  return new Command('login')
    .description('登录服务器并验证客户端令牌')
    .option('--server <url>', '服务器地址，可包含部署路径')
    .addOption(new Option('--token <token>', '客户端令牌，建议改用隐藏输入或 --token-stdin').conflicts('tokenStdin'))
    .addOption(new Option('--token-stdin', '从标准输入读取一行令牌（最多 4096 字节，等待 30 秒）').conflicts('token'))
    .option('-v, --verbose', '显示错误代码与技术细节')
    .addHelpText('after', '\n示例:\n  owngate login --server https://bridge.example.com\n  your-secret-command | owngate login --server https://bridge.example.com --token-stdin')
    .action(async (options: LoginOptions) => {
      try {
        const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
        if (!interactive && (!options.server || (!options.token && !options.tokenStdin))) {
          throw new CliUsageError('非交互登录缺少服务器地址或客户端令牌。', '指定 --server <url>，并用 --token-stdin 传入令牌；也可兼容使用 --token <token>。')
        }
        if (options.tokenStdin && process.stdin.isTTY && !interactive) {
          throw new CliUsageError('标准输入仍连接到终端，无法进行非交互令牌输入。', '将令牌通过管道传给 --token-stdin，或在交互终端中运行 login 使用隐藏输入。')
        }
        const server = normalizeServerUrl(options.server ?? await promptInput('服务器地址: '))
        const suppliedToken = options.token ?? (options.tokenStdin && !process.stdin.isTTY
          ? await readTokenFromStdin()
          : await promptInput('客户端令牌（隐藏输入）: ', { hidden: true }))
        const token = normalizeToken(suppliedToken)
        const result = await apiCall('/api/connections', 'GET', undefined, { config: { server, token } }) as { connections?: unknown }
        if (!Array.isArray(result.connections)) {
          console.error('服务器返回了无效的连接列表，未保存登录配置。')
          console.error('检查服务器地址是否指向 owngate 服务后重试。')
          process.exitCode = 1
          return
        }
        try { writeConfig({ server, token }) } catch {
          console.error('登录验证成功，但无法保存本地配置。')
          console.error('检查 CLI 配置目录的写入权限后重试。')
          process.exitCode = 1
          return
        }
        console.error(`登录成功，已获准访问 ${result.connections.length} 个连接。`)
        console.error(result.connections.length === 0
          ? '在后台「客户端」为此令牌分配连接与能力，再运行 owngate status。'
          : '运行 owngate conn 查看连接，或用 owngate conn use <名称> 设置默认连接。')
      } catch (error) {
        process.exitCode = reportCliFailure(error, options.verbose)
      }
    })
}
