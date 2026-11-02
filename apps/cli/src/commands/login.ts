import { Command } from 'commander'
import * as readline from 'node:readline'
import { writeConfig, readConfig } from '../config.js'
import { adminCall } from '../http.js'
import type { Connection } from '@webridge/core'

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

export const loginCommand = new Command('login')
  .description('Authenticate with a webridge server')
  .action(async () => {
    try {
      const server = await prompt('Server URL: ')
      const token = await prompt('Bearer token: ')
      writeConfig({ server, token })
      // Verify by calling GET /admin/connections
      const data = (await adminCall('/admin/connections')) as { connections: Connection[] }
      const count = data.connections?.length ?? 0
      console.log(`Logged in. Found ${count} connection(s).`)
    } catch (e) {
      console.error('Login failed:', (e as Error).message)
      process.exit(1)
    }
  })
