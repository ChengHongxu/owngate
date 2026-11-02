import { Command } from 'commander'
import Table from 'cli-table3'
import { apiCall } from '../http.js'
import type { Capability } from '@webridge/core'

export const capCommand = new Command('cap')
  .description('Manage capabilities')

capCommand
  .command('ls <connection_id>')
  .description('List the capabilities this token is granted on a connection')
  .action(async (connectionId: string) => {
    try {
      // 404 CONNECTION_NOT_FOUND covers both unknown and ungranted connections.
      const data = (await apiCall(
        `/api/connections/${encodeURIComponent(connectionId)}/capabilities`,
      )) as { capabilities?: Capability[] }
      const capabilities = data.capabilities ?? []

      if (capabilities.length === 0) {
        console.log(`No capabilities granted on connection ${connectionId}.`)
        return
      }

      const table = new Table({
        head: ['ID', 'Kind', 'Title', 'Effect', 'Support'],
        style: { head: ['cyan'] },
      })
      for (const cap of capabilities) {
        table.push([
          cap.id,
          cap.kind,
          cap.title,
          cap.effect,
          cap.support?.status ?? '',
        ])
      }
      console.log(table.toString())
    } catch (e) {
      console.error('Error:', (e as Error).message)
      process.exit(1)
    }
  })
