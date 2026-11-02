import { Command } from 'commander'
import { apiCall } from '../http.js'
import type { Task } from '@webridge/core'

export const taskCommand = new Command('task')
  .description('Inspect tasks')

taskCommand
  .command('get <id>')
  .description('Fetch a task by ID (polling not implemented in M0)')
  .option('--wait <duration>', 'Accepted for compatibility; M0 fetches once')
  .action(async (id: string) => {
    try {
      const task = (await apiCall(`/api/tasks/${encodeURIComponent(id)}`)) as Task
      console.log(JSON.stringify(task, null, 2))
    } catch (e) {
      console.error('Error:', (e as Error).message)
      process.exit(1)
    }
  })
