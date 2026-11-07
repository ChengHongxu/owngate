import { Command } from 'commander'
import pc from 'picocolors'
import { apiCall, ApiError } from '../http.js'
import { EXIT_CODE, USAGE_EXIT_CODE } from '@owngate/core'
import type { ResultEnvelope, Task } from '@owngate/core'
import { durationMs, waitForTask, taskExitCode } from './task.js'
import { reportCapabilityError, reportCliFailure } from '../diagnostics.js'
import { resolveConnection } from '../connections.js'
import { CliUsageError } from '../errors.js'

function isEnvelope(value: unknown): value is ResultEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const body = value as Record<string, unknown>
  return typeof body['status'] === 'string' && Object.hasOwn(EXIT_CODE, body['status']) && ['success', 'partial', 'error'].includes(String(body['outcome'])) && typeof body['source'] === 'object'
}

function exitCode(envelope: ResultEnvelope): number {
  return envelope.error?.code === 'INVALID_PARAMS' ? USAGE_EXIT_CODE : EXIT_CODE[envelope.status]
}

function taskTicket(value: unknown): { status: 'pending'; task_id: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const body = value as Record<string, unknown>
  return body['status'] === 'pending' && typeof body['task_id'] === 'string' && body['task_id'] !== ''
    ? { status: 'pending', task_id: body['task_id'] } : undefined
}

export function createQueryCommand(): Command {
  return new Command('query')
  .description('查询能力；设置默认连接后只需填写能力名称')
  .argument('[connection-or-capability]', '连接名称或 ID；省略连接时填写能力名称')
  .argument('[capability]', '能力名称，例如 account.balance')
  .option('-p, --param <k=v>', '输入参数，可重复；数字、布尔值等按 JSON 类型解析', (value, previous: string[]) => [...previous, value], [] as string[])
  .option('--input <json>', '以 JSON 对象提供输入参数；--param 可覆盖其中的字段')
  .option('-j, --json', '输出完整 JSON 结果（非终端默认）')
  .option('--no-cache', '跳过缓存')
  .option('--all', '查询全部获准个人连接，与显式连接、--tag 互斥')
  .option('--tag <tag>', '按标签查询个人连接，与显式连接、--all 互斥')
  .option('--async', '提交单连接任务后立即返回')
  .option('--wait <duration>', '长任务最多等待多久，例如 30s、2m', '30s')
  .option('-v, --verbose', '在 stderr 显示技术诊断')
  .addHelpText('after', '\n示例：\n  owngate query AFF account.balance\n  owngate query account.balance             # 使用默认连接\n  owngate query feed.list -p limit=10\n  owngate query account.balance --all --json\n  owngate cap show AFF account.balance      # 查看参数\n')
  .action(async (connectionId: string | undefined, capabilityId: string | undefined, options: { param: string[]; input?: string; json: boolean; cache: boolean; all?: boolean; tag?: string; async?: boolean; wait: string; verbose?: boolean }) => {
    let input: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    let waitMs: number
    try {
      waitMs = durationMs(options.wait)
      if (options.all && options.tag !== undefined) throw new CliUsageError('--all 和 --tag 不能同时使用。', '选择其中一种查询范围，例如 owngate query account.balance --all。')
      if ((options.all || options.tag !== undefined) && capabilityId !== undefined) throw new CliUsageError('批量查询不能同时指定连接。', '只填写能力，例如 owngate query account.balance --all。')
      if (capabilityId === undefined) { capabilityId = connectionId; connectionId = undefined }
      if (!capabilityId?.trim()) throw new CliUsageError('请指定要查询的能力。', '运行 owngate cap ls 查看能力，或用 owngate query --help 查看示例。')
      if (options.tag !== undefined && !options.tag.trim()) throw new CliUsageError('标签不能为空。', '填写标签名称，例如 owngate query account.balance --tag work。')
      if (options.async && (options.all || options.tag !== undefined)) throw new CliUsageError('--async 只支持单个连接。', '指定连接名称，或先用 owngate conn use 设置默认连接。')
      if (options.input !== undefined) {
        const parsed = JSON.parse(options.input) as unknown
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new CliUsageError('--input 必须是 JSON 对象。', '例如 --input \'{"limit":10}\'；用 owngate cap show 查看参数。')
        Object.assign(input, parsed)
      }
      for (const param of options.param) {
        const eq = param.indexOf('=')
        if (eq <= 0) throw new CliUsageError('--param 的格式应为 参数名=值。', '例如 -p limit=10；用 owngate cap show 查看参数。')
        const raw = param.slice(eq + 1)
        let value: unknown = raw
        try { value = JSON.parse(raw) } catch { /* A plain string is also a valid CLI parameter. */ }
        input[param.slice(0, eq)] = value
      }
    } catch (error) {
      process.exitCode = reportCliFailure(error instanceof SyntaxError
        ? new CliUsageError('--input 不是有效 JSON。', '用单引号包住 JSON，例如 --input \'{"limit":10}\'。') : error, options.verbose)
      return
    }
    try {
      if (options.all || options.tag !== undefined) {
        const batch = await apiCall('/api/query', 'POST', { capability_id: capabilityId, input, ...(options.tag !== undefined ? { tag: options.tag } : { all: true }), no_cache: !options.cache }) as { status: keyof typeof EXIT_CODE }
        console.log(JSON.stringify(batch, null, 2))
        process.exitCode = EXIT_CODE[batch.status] ?? 1
        return
      }
      const connection = await resolveConnection(connectionId)
      const body = { connection_id: connection.id, capability_id: capabilityId, input, ...(!options.cache ? { no_cache: true } : {}) }
      if (options.async) {
        console.log(JSON.stringify(await apiCall('/api/tasks', 'POST', body), null, 2))
        process.exitCode = EXIT_CODE.pending
        return
      }
      let response: unknown
      let asyncAccepted = false
      try { response = await apiCall('/api/invoke', 'POST', body, { preferAsync: true,
        onResponse: (http) => { asyncAccepted = http.status === 202 } }) } catch (error) {
        if (!(error instanceof ApiError) || !isEnvelope(error.body)) throw error
        response = error.body
      }
      const ticket = asyncAccepted ? taskTicket(response) : undefined
      if (ticket) {
        let task: Task | undefined
        try { task = await waitForTask(ticket.task_id, waitMs) }
        catch (error) {
          // The server has already accepted this task. Keep its ticket usable
          // even if polling fails; never retry the submission automatically.
          console.log(JSON.stringify(ticket, null, 2))
          const failure = reportCliFailure(error, options.verbose)
          process.exitCode = failure === 1 ? EXIT_CODE.pending : failure
          return
        }
        if (!task || ['pending', 'running'].includes(task.status)) {
          console.log(JSON.stringify(ticket, null, 2))
          process.exitCode = EXIT_CODE.pending
          return
        }
        if (task.result) response = task.result
        else {
          console.log(JSON.stringify(task, null, 2))
          process.exitCode = taskExitCode(task)
          return
        }
      }
      if (!isEnvelope(response)) throw new Error('The server returned an invalid result envelope.')
      const envelope = response
      if (options.json || !process.stdout.isTTY) {
        console.log(JSON.stringify(envelope, null, 2))
        if (envelope.error) reportCapabilityError(envelope.error, options.verbose)
        process.exitCode = exitCode(envelope)
        return
      }
      const color = envelope.outcome === 'success' ? pc.green : envelope.outcome === 'partial' ? pc.yellow : pc.red
      console.log(`${envelope.source.connection_label} · ${envelope.source.capability_id} · ${color(envelope.outcome === 'success' ? '已完成' : envelope.outcome === 'partial' ? '部分完成' : '失败')}`)
      console.log(`查询时间 ${envelope.queried_at} · 数据时间 ${envelope.data_time ?? '未知'}${envelope.cache ? ` · ${envelope.cache.hit ? '缓存命中' : '实时查询'}` : ''}`)
      for (const warning of envelope.warnings) console.error(pc.yellow(`提示：${warning}`))
      if (envelope.error) {
        reportCapabilityError(envelope.error, options.verbose)
      }
      if (envelope.data !== null) console.log(JSON.stringify(envelope.data, null, 2))
      process.exitCode = exitCode(envelope)
    } catch (error) {
      process.exitCode = reportCliFailure(error, options.verbose)
    }
  })
}
