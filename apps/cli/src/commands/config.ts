import { Command } from 'commander'
import { writeConfig } from '../config.js'

const configSetCommand = new Command('set')
  .description('Set a config value')

configSetCommand
  .command('server <url>')
  .description('Set the server URL')
  .action((url: string) => {
    try {
      writeConfig({ server: url })
      console.log(`Server set to ${url}`)
    } catch (e) {
      console.error('Failed to save config:', (e as Error).message)
      process.exit(1)
    }
  })

configSetCommand
  .command('token <token>')
  .description('Set the Bearer token')
  .action((token: string) => {
    try {
      writeConfig({ token })
      console.log('Token saved.')
    } catch (e) {
      console.error('Failed to save config:', (e as Error).message)
      process.exit(1)
    }
  })

export const configCommand = new Command('config')
  .description('Manage CLI configuration')
  .addCommand(configSetCommand)
