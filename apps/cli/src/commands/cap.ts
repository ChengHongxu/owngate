import { Command } from 'commander'
import Table from 'cli-table3'
import { adminCall } from '../http.js'
import type { Connection, Capability } from '@webridge/core'

export const capCommand = new Command('cap')
  .description('Manage capabilities')

capCommand
  .command('ls <connection_id>')
  .description('List capabilities for a connection')
  .action(async (connectionId: string) => {
    try {
      // Look up connection to get connector_id
      const connData = (await adminCall('/admin/connections')) as { connections: Connection[] }
      const connection = connData.connections?.find((c) => c.id === connectionId)
      if (!connection) {
        console.error(`Connection not found: ${connectionId}`)
        process.exit(1)
      }
      const connectorId = connection.connector_id

      // Get all capabilities and filter by connector_id
      const capData = (await adminCall('/admin/capabilities')) as {
        capabilities: Array<{ key: string } & Capability>
      }
      const capabilities = (capData.capabilities ?? []).filter(
        (cap) => cap.key?.startsWith(`${connectorId}/`) || cap.id?.startsWith(`${connectorId}/`),
      )

      if (capabilities.length === 0) {
        console.log(`No capabilities found for connection ${connectionId} (connector: ${connectorId}).`)
        return
      }

      const table = new Table({
        head: ['Key', 'Kind', 'Title', 'Effect', 'Support'],
        style: { head: ['cyan'] },
      })
      for (const cap of capabilities) {
        table.push([
          cap.key ?? cap.id,
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
