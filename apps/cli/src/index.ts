import { Command } from 'commander'
import { loginCommand } from './commands/login.js'
import { configCommand } from './commands/config.js'
import { connCommand } from './commands/conn.js'
import { capCommand } from './commands/cap.js'
import { queryCommand } from './commands/query.js'
import { taskCommand } from './commands/task.js'

export function createProgram(): Command {
  const program = new Command()

  program
    .name('webridge')
    .description('webridge CLI — invoke capabilities via the webridge server')
    .version('0.1.0')

  program.addCommand(loginCommand)
  program.addCommand(configCommand)
  program.addCommand(connCommand)
  program.addCommand(capCommand)
  program.addCommand(queryCommand)
  program.addCommand(taskCommand)

  return program
}
