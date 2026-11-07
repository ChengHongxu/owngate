import { Command } from 'commander'
import { setTimeout as delay } from 'node:timers/promises'
import { apiCall, ApiTimeoutError, DEFAULT_TIMEOUT_MS } from '../http.js'
import { EXIT_CODE, USAGE_EXIT_CODE } from '@owngate/core'
import type { Task } from '@owngate/core'
import { reportCliFailure } from '../diagnostics.js'
import { CliUsageError } from '../errors.js'
import Table from 'cli-table3'

export function durationMs(value: string, flag = '--wait'): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(value)
  if (!match) throw new CliUsageError(`${flag} 不是有效的等待时长。`, `填写正数时长，例如 ${flag} 500ms、30s 或 2m。`)
  const multiplier = match[2] === 'ms' ? 1 : match[2] === 'm' ? 60_000 : 1000
  const milliseconds = Number(match[1]) * multiplier
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 86_400_000) throw new CliUsageError(`${flag} 必须大于零，且不超过 24 小时。`, `例如 ${flag} 30s。`)
  return milliseconds
}

export function taskExitCode(task: Task): number {
  if (task.result) return task.result.error?.code === 'INVALID_PARAMS' ? USAGE_EXIT_CODE : EXIT_CODE[task.result.status]
  return task.status === 'success' ? 0 : task.status === 'partial' ? EXIT_CODE.partial : task.status === 'unknown_outcome' ? EXIT_CODE.unknown_outcome : 1
}

/** Poll an accepted task without ever invoking or submitting it again. */
export async function waitForTask(id: string, waitMs: number): Promise<Task | undefined> {
  const deadline = Date.now() + waitMs
  let task: Task | undefined
  do {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return task
    try {
      task = await apiCall(`/api/tasks/${encodeURIComponent(id)}`, 'GET', undefined, { timeoutMs: Math.min(DEFAULT_TIMEOUT_MS, remaining) }) as Task
    } catch (error) {
      if (error instanceof ApiTimeoutError && Date.now() >= deadline) return task
      throw error
    }
    if (!['pending', 'running'].includes(task.status)) return task
    await delay(Math.min(500, Math.max(0, deadline - Date.now())))
  } while (true)
}

function reportError(error: unknown): void {
  process.exitCode = reportCliFailure(error)
}

export function createTaskCommand(): Command {
  const taskCommand = new Command('task').description('查看、等待或取消任务')
  taskCommand.action(() => { taskCommand.outputHelp() })

taskCommand.command('ls').alias('list')
  .description('列出当前客户端可见的任务')
  .option('--limit <number>', '最多显示多少项（1–100）', '50')
  .option('-j, --json', '输出完整 JSON（非终端默认）')
  .action(async (options: { limit: string; json?: boolean }) => {
    const limit = Number(options.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      reportError(new CliUsageError('--limit 必须是 1–100 之间的整数。', '例如 owngate task ls --limit 20。'))
      return
    }
    try {
      const result = await apiCall(`/api/tasks?limit=${limit}`) as { tasks: Task[] }
      if (options.json || !process.stdout.isTTY) console.log(JSON.stringify(result, null, 2))
      else if (!result.tasks.length) console.log('暂无任务。')
      else {
        const table = new Table({ head: ['任务 ID', '连接', '能力', '状态'] })
        for (const task of result.tasks) table.push([task.id, task.connection_id, task.capability_id, task.status])
        console.log(table.toString())
      }
    }
    catch (error) { reportError(error) }
  })

taskCommand.command('events <id>')
  .description('查看任务过程记录')
  .option('--after <id>', '只读取此数字事件 ID 之后的记录', '0')
  .option('-j, --json', '输出 JSON')
  .action(async (id: string, options: { after: string }) => {
    const after = Number(options.after)
    if (!Number.isSafeInteger(after) || after < 0) {
      reportError(new CliUsageError('--after 必须是非负整数。', '例如 owngate task events <任务ID> --after 0。'))
      return
    }
    try { console.log(JSON.stringify(await apiCall(`/api/tasks/${encodeURIComponent(id)}/events?after=${after}`), null, 2)) }
    catch (error) { reportError(error) }
  })

taskCommand.command('cancel <id>')
  .description('取消本地任务；已发送给平台的操作可能继续')
  .option('-j, --json', '输出 JSON')
  .action(async (id: string) => {
    try { console.log(JSON.stringify(await apiCall(`/api/tasks/${encodeURIComponent(id)}/cancel`, 'POST'), null, 2)) }
    catch (error) { reportError(error) }
  })

taskCommand.command('get <id>')
  .description('读取任务；可等待至完成或指定时限')
  .option('--wait <duration>', '最多等待多久，例如 30s')
  .option('-j, --json', '输出 JSON')
  .action(async (id: string, options: { wait?: string }) => {
    let waitMs: number | undefined
    try { waitMs = options.wait === undefined ? undefined : durationMs(options.wait) } catch (error) {
      reportError(error)
      return
    }
    let task: Task | undefined
    try {
      task = waitMs === undefined
        ? await apiCall(`/api/tasks/${encodeURIComponent(id)}`) as Task
        : await waitForTask(id, waitMs)
      if (!task || ['pending', 'running'].includes(task.status)) {
        console.log(JSON.stringify({ status: 'pending', task_id: id, ...(task ? { task } : {}) }, null, 2))
        process.exitCode = EXIT_CODE.pending
        return
      }
      console.log(JSON.stringify(task, null, 2))
      process.exitCode = taskExitCode(task)
    } catch (error) { reportError(error) }
  })
  return taskCommand
}
