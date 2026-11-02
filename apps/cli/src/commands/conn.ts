import { Command } from 'commander'
import Table from 'cli-table3'
import { apiCall } from '../http.js'

/** GET /api/connections item: only connections this token is granted (§8.4). */
export interface GrantedConnection {
  id: string
  connector_id: string
  label: string
  granted: string[]
}

export async function listGrantedConnections(): Promise<GrantedConnection[]> {
  const data = (await apiCall('/api/connections')) as { connections?: GrantedConnection[] }
  return data.connections ?? []
}

export const connCommand = new Command('conn')
  .description('Manage connections')

connCommand
  .command('ls')
  .description('List the connections this token is granted')
  .action(async () => {
    try {
      const connections = await listGrantedConnections()
      if (connections.length === 0) {
        console.log('No connections granted to this token.')
        return
      }
      const table = new Table({
        head: ['ID', 'Connector', 'Label', 'Granted'],
        style: { head: ['cyan'] },
      })
      for (const c of connections) {
        table.push([c.id, c.connector_id, c.label, c.granted.join(', ')])
      }
      console.log(table.toString())
    } catch (e) {
      console.error('Error:', (e as Error).message)
      process.exit(1)
    }
  })
