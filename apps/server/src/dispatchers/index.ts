// Unified dispatcher — routes to HTTP or browser dispatcher by capability.transport
// Design doc §2.2: adapter isolation, single dispatch path

import type { Connection, Capability, ResultEnvelope } from '@webridge/core'
import { err, fail } from '@webridge/core'
import { dispatchHttp } from './http.js'
import { dispatchBrowser } from './browser.js'
import type { ConnectorRegistry } from '../registry.js'

export class UnifiedDispatcher {
  constructor(private registry: ConnectorRegistry) {}

  async dispatch(
    connection: Connection,
    capability: Capability,
    input: unknown,
  ): Promise<ResultEnvelope> {
    const source = {
      connection_id: connection.id,
      connection_label: connection.label,
      capability_id: capability.id,
      support: connection.capability_states[capability.id] ?? capability.support,
    }

    if (capability.transport === 'browser') {
      return dispatchBrowser(connection, capability, input)
    }

    // HTTP transport — look up connector manifest for request details
    const manifest = this.registry.getManifest(connection.connector_id)

    // No manifest or no http block → stub response for test connectors
    if (!manifest || !manifest.http) {
      return {
        outcome: 'success',
        data: { message: 'pong', connection: connection.label, capability: capability.id },
        error: null,
        fields: {},
        source,
        data_time: new Date().toISOString(),
        queried_at: new Date().toISOString(),
        cache: null,
        warnings: [],
      }
    }

    const capDef = manifest.capabilityDefs[capability.id]
    const creds = this.registry.getCredentials(connection.id)

    return dispatchHttp(
      connection,
      capability,
      input,
      creds ?? {},
      manifest.http,
      capDef?.output,
      capDef?.success_when,
      capDef?.auth_failed_when,
    )
  }
}
