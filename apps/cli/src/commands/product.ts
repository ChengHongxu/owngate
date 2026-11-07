import { Command } from 'commander'
import { apiCall } from '../http.js'
import { EXIT_CODE } from '@owngate/core'
import { resolveConnection } from '../connections.js'
import { CliUsageError } from '../errors.js'
import { reportCliFailure } from '../diagnostics.js'

export function createFeedCommand(): Command {
  return new Command('feed')
    .description('读取信息流；默认使用已设置或唯一的连接')
    .option('--all', '汇总全部获准个人连接，与 --connection 互斥')
    .option('-c, --connection <connection>', '连接名称或 ID，可显式选择组织连接')
    .option('--limit <number>', '每个平台的条数（1–100）', '20')
    .option('--since <duration>', '最近的时间范围，例如 6h、7d（最长 365d）')
    .option('-j, --json', '输出 JSON')
    .option('-v, --verbose', '在 stderr 显示技术诊断')
    .addHelpText('after', '\n示例：\n  owngate feed --connection bilibili --since 6h\n  owngate feed --all --limit 10\n')
    .action(async (options: { all?: boolean; connection?: string; limit: string; since?: string; verbose?: boolean }) => {
      try {
        if (options.all && options.connection !== undefined) throw new CliUsageError('--all 和 --connection 不能同时使用。', '选择单个连接，或仅用 owngate feed --all 汇总个人连接。')
        const limit = Number(options.limit)
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CliUsageError('--limit 必须是 1–100 之间的整数。', '例如 owngate feed --limit 20。')
        if (options.since !== undefined) {
          const match = /^([1-9][0-9]{0,4})(m|h|d)$/.exec(options.since)
          const seconds = match ? Number(match[1]) * (match[2] === 'm' ? 60 : match[2] === 'h' ? 3600 : 86400) : 0
          if (seconds < 60 || seconds > 365 * 86400) throw new CliUsageError('--since 应为 1m 到 365d 之间的时间范围。', '例如 --since 6h 或 --since 7d。')
        }
        const connection = options.all ? undefined : await resolveConnection(options.connection)
        const result = await apiCall('/api/feed', 'POST', {
          ...(connection ? { connection_ids: [connection.id] } : { all: true }),
          ...(options.since ? { since: options.since } : {}), input: { limit },
        }) as { status: keyof typeof EXIT_CODE }
        console.log(JSON.stringify(result, null, 2))
        process.exitCode = EXIT_CODE[result.status] ?? 1
      } catch (error) { process.exitCode = reportCliFailure(error, options.verbose) }
    })
}

export function createActionCommand(): Command {
  const command = new Command('action').description('提交和查看操作提案；批准须在后台完成')
  command.action(() => { command.outputHelp() })
  command.command('propose <connection> <capability>')
    .description('按连接名称或 ID 提交提案')
    .option('--input <json>', '精确的 JSON 参数对象', '{}')
    .option('-j, --json', '输出 JSON')
    .option('-v, --verbose', '在 stderr 显示技术诊断')
    .action(async (selector: string, capability: string, options: { input: string; verbose?: boolean }) => {
      try {
        if (!capability.trim()) throw new CliUsageError('请指定提案能力。', '用 owngate cap ls <连接> 查看已授权能力。')
        let input: unknown
        try { input = JSON.parse(options.input) }
        catch { throw new CliUsageError('--input 不是有效 JSON。', '用单引号包住 JSON，例如 --input \'{"text":"内容"}\'。') }
        if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new CliUsageError('--input 必须是 JSON 对象。', '用 owngate cap show <连接> <能力> 查看参数。')
        const connection = await resolveConnection(selector)
        console.log(JSON.stringify(await apiCall('/api/proposals', 'POST', { connection_id: connection.id, capability_id: capability, input }), null, 2))
        process.exitCode = EXIT_CODE.needs_approval
      } catch (error) { process.exitCode = reportCliFailure(error, options.verbose) }
    })
  command.command('get <id>')
    .description('查看提案详情')
    .option('-j, --json', '输出 JSON')
    .option('-v, --verbose', '在 stderr 显示技术诊断')
    .action(async (id: string, options: { verbose?: boolean }) => {
      try { console.log(JSON.stringify(await apiCall(`/api/proposals/${encodeURIComponent(id)}`), null, 2)) }
      catch (error) { process.exitCode = reportCliFailure(error, options.verbose) }
    })
  return command
}

export function createPauseCommand(): Command {
  return new Command('pause')
    .description('紧急暂停全部写操作；恢复须在后台完成')
    .requiredOption('--all-actions', '暂停全部写操作')
    .option('-j, --json', '输出 JSON')
    .option('-v, --verbose', '在 stderr 显示技术诊断')
    .action(async (options: { verbose?: boolean }) => {
      try { console.log(JSON.stringify(await apiCall('/api/actions/pause', 'POST', {}), null, 2)) }
      catch (error) { process.exitCode = reportCliFailure(error, options.verbose) }
    })
}

export const actionCommand = createActionCommand()
