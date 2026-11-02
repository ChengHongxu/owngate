import { Command } from 'commander'
import * as readline from 'node:readline'
import { writeConfig, readConfig } from '../config.js'
import { listGrantedConnections } from './conn.js'

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
      // Verify the token against the client-token API (/admin/* needs an
      // admin session and would always refuse a CLI token).
      const count = (await listGrantedConnections()).length
      console.log(`Logged in. ${count} connection(s) granted to this token.`)
    } catch (e) {
      console.error('Login failed:', (e as Error).message)
      process.exit(1)
    }
  })
