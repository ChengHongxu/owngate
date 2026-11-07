import { Command } from 'commander'
import { createLoginCommand } from './commands/login.js'
import { createConfigCommand } from './commands/config.js'
import { createConnCommand } from './commands/conn.js'
import { createCapCommand } from './commands/cap.js'
import { createQueryCommand } from './commands/query.js'
import { createTaskCommand } from './commands/task.js'
import { createMcpCommand } from './commands/mcp.js'
import { createVaultCommand } from './commands/vault.js'
import { createAdminCommand } from './commands/admin.js'
import { createFeedCommand, createActionCommand, createPauseCommand } from './commands/product.js'
import { createStatusCommand } from './commands/status.js'

export function createProgram(forCatch = false): Command {
  const program = new Command()

  program
    .name('owngate')
    .description('通过连接名称查询网站能力')
    .version('0.1.4')
    .allowExcessArguments(true)
    .action(() => {
      if (program.args.length) program.error(`error: unknown command ${JSON.stringify(program.args[0])}`, { code: 'commander.unknownCommand' })
      program.outputHelp()
    })
    .addHelpText('after', '\n常用操作：\n  owngate login --server http://localhost:3000\n  owngate conn                         # 查看获准连接\n  owngate cap ls AFF                    # 查看 AFF 的能力\n  owngate cap show AFF account.balance  # 查看参数与示例\n  owngate query AFF account.balance\n  owngate conn use AFF                  # 设置默认连接\n  owngate query account.balance         # 省略默认连接名称\n\n名称含空格时请加引号；脚本中仍可使用完整连接 ID。\n')

  program.addCommand(createLoginCommand())
  program.addCommand(createStatusCommand())
  program.addCommand(createConnCommand())
  program.addCommand(createCapCommand())
  program.addCommand(createQueryCommand())
  program.addCommand(createFeedCommand())
  program.addCommand(createTaskCommand())
  program.addCommand(createActionCommand())
  program.addCommand(createPauseCommand())
  program.addCommand(createConfigCommand())
  program.addCommand(createMcpCommand())
  program.addCommand(createVaultCommand())
  program.addCommand(createAdminCommand())

  // addCommand does not inherit an exit handler. Configure every level so usage
  // errors and --help never terminate an embedding process or get printed twice.
  if (forCatch) {
    const configure = (command: Command) => {
      command.exitOverride((error) => { throw error })
      for (const child of command.commands) configure(child)
    }
    configure(program)
  }

  return program
}
