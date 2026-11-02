import { Command } from 'commander'
import pc from 'picocolors'
import { apiCall } from '../http.js'
import type { ResultEnvelope } from '@webridge/core'

export const queryCommand = new Command('query')
  .description('Invoke a capability')
  .argument('<connection_id>', 'Connection ID')
  .argument('<capability_id>', 'Capability ID')
  .option('-p, --param <k=v>', 'Input parameter (repeatable)', (val, prev: string[]) => [...prev, val], [] as string[])
  .option('--json', 'Output raw envelope JSON')
  .option('--no-cache', 'Bypass cache')
  .action(async (connectionId: string, capabilityId: string, opts: { param: string[]; json: boolean; cache: boolean }) => {
    try {
      const input: Record<string, string> = {}
      for (const p of opts.param) {
        const eq = p.indexOf('=')
        if (eq === -1) {
          console.error(`Invalid param "${p}" — expected k=v format`)
          process.exit(1)
        }
        input[p.slice(0, eq)] = p.slice(eq + 1)
      }

      const body: Record<string, unknown> = {
        connection_id: connectionId,
        capability_id: capabilityId,
      }
      if (Object.keys(input).length > 0) body['input'] = input
      if (!opts.cache) body['no_cache'] = true

      const envelope = (await apiCall('/api/invoke', 'POST', body)) as ResultEnvelope

      if (opts.json) {
        console.log(JSON.stringify(envelope, null, 2))
        if (envelope.outcome === 'error') process.exit(1)
        return
      }

      // Human-readable summary
      const outcomeColor =
        envelope.outcome === 'success'
          ? pc.green(envelope.outcome)
          : envelope.outcome === 'partial'
          ? pc.yellow(envelope.outcome)
          : pc.red(envelope.outcome)

      console.log(`Outcome:    ${outcomeColor}`)
      console.log(`Source:     ${envelope.source.connection_label} / ${envelope.source.capability_id}`)
      console.log(`Queried at: ${envelope.queried_at}`)
      console.log(`Data time:  ${envelope.data_time}`)

      if (envelope.cache) {
        const hit = envelope.cache.hit ? pc.green('HIT') : pc.dim('MISS')
        console.log(`Cache:      ${hit} (expires ${envelope.cache.expires_at})`)
      }

      if (envelope.warnings.length > 0) {
        for (const w of envelope.warnings) {
          console.log(pc.yellow(`Warning: ${w}`))
        }
      }

      if (envelope.outcome === 'error' && envelope.error) {
        console.error(pc.red(`Error [${envelope.error.code}]: ${envelope.error.message}`))
        process.exit(1)
      }

      if (envelope.data !== null) {
        console.log('\nData:')
        console.log(JSON.stringify(envelope.data, null, 2))
      }
    } catch (e) {
      console.error(pc.red('Error: ' + (e as Error).message))
      process.exit(1)
    }
  })
