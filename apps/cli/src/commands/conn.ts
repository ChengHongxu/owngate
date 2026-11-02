import { Command } from 'commander'
import Table from 'cli-table3'
import { adminCall } from '../http.js'
import type { Connection } from '@webridge/core'

export const connCommand = new Command('conn')
  .description('Manage connections')

connCommand
  .command('ls')
  .description('List all connections')
  .action(async () => {
    try {
      const data = (await adminCall('/admin/connections')) as { connections: Connection[] }
      const connections = data.connections ?? []
      if (connections.length === 0) {
        console.log('No connections found.')
        return
      }
      const table = new Table({
        head: ['ID', 'Connector', 'Label'],
        style: { head: ['cyan'] },
      })
      for (const c of connections) {
        table.push([c.id, c.connector_id, c.label])
      }
      console.log(table.toString())
    } catch (e) {
      console.error('Error:', (e as Error).message)
      process.exit(1)
    }
  })
