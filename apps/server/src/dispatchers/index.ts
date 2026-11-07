// Unified dispatcher — routes to HTTP or browser dispatcher by capability.transport
// Design doc §2.2: adapter isolation, single dispatch path

import type { Connection, Capability, ResultEnvelope } from '@owngate/core';
import { err, fail } from '@owngate/core';
import { dispatchHttp } from './http.js';
import { dispatchBrowser } from './browser.js';
import type { ConnectorRegistry } from '../registry.js';
import type { BrowserClient } from '../browser-client.js';
import { egressPolicy } from '../egress-policy.js';
import type { IsolatedHttpRuntime } from '../http-runtime.js';
import { observeExecution } from '../execution-trace.js';

export class UnifiedDispatcher {
  constructor(
    private registry: ConnectorRegistry,
    private browserClient: BrowserClient,
    private httpRuntime?: IsolatedHttpRuntime,
  ) {}

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
    };

    if (capability.transport === 'browser') {
      return observeExecution('transport.browser', '调用浏览器执行服务', () =>
        dispatchBrowser(this.browserClient, connection, capability, input, egressPolicy(connection, this.registry)));
    }
    if (this.httpRuntime) return observeExecution('transport.http', '调用隔离 HTTP 执行服务', () => this.httpRuntime!.dispatch(connection, capability, input));

    // HTTP transport — look up connector manifest for request details
    const manifest = this.registry.getManifest(connection.connector_id);

    // Missing implementations must never look like successful site queries.
    if (!manifest || !manifest.http) {
      return fail(err('CAPABILITY_UNSUPPORTED', 'This connector has no HTTP implementation'), source);
    }

    const capDef = manifest.capabilityDefs[capability.id];
    const creds = this.registry.getCredentials(connection.id);

    return observeExecution('transport.http', '执行声明的 HTTP 查询', () => dispatchHttp(
      connection,
      capability,
      input,
      creds ?? {},
      manifest.http,
      capDef?.output,
      capDef?.success_when,
      capDef?.auth_failed_when,
      capDef?.request,
      manifest.compiled.discovery,
    ));
  }
}
