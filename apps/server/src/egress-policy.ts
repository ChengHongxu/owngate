import type { Connection } from '@owngate/core';
import type { ConnectorRegistry } from './registry.js';
import type { EgressPolicy } from './browser-client.js';

export function egressPolicy(connection: Connection, registry: ConnectorRegistry): EgressPolicy {
  const login = registry.getLogin(connection.connector_id);
  return { allowed_domains: login?.allowedDomains ?? [], strict: connection.config['egress_strict'] === true };
}
