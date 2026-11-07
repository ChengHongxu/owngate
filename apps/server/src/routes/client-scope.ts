// What a client token may see (design §8.4): only connections it holds a grant
// for, and within each connection only the granted capabilities. Shared by the
// client-token REST listing (GET /api/connections...) and the MCP
// list_connections tool, so CLI and MCP always list the same thing.

import { err, isCapabilityRoleAllowed, isClientExpired } from '@owngate/core';
import type {
  ApiError, AuthStore, Capability, Client, Connection, ConnectionStore, Grant,
} from '@owngate/core';
import { effectiveCapabilityState } from '../connection-status.js';

export type ClientAuthResult =
  | { ok: true; client: Client }
  | { ok: false; error: ApiError };

/** Parse `Authorization: Bearer <token>`; null when absent or malformed. */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

/**
 * Resolve a client token the same way invoke() does: unknown → UNAUTHENTICATED,
 * revoked → CLIENT_REVOKED. A missing token is answered like an unknown one
 * (§6.1: do not tell a prober which of the two it was).
 */
export function authenticateClient(
  token: string | null,
  auth: AuthStore,
  hashToken: (token: string) => string,
): ClientAuthResult {
  const client = token === null ? undefined : auth.getClient(hashToken(token));
  if (client === undefined) return { ok: false, error: err('UNAUTHENTICATED', 'Invalid or expired token') };
  if (client.revoked) return { ok: false, error: err('CLIENT_REVOKED', 'This client has been revoked') };
  if (isClientExpired(client)) return { ok: false, error: err('UNAUTHENTICATED', 'This client token has expired') };
  return { ok: true, client };
}

/** Connection as shown to a client token. Config is never exposed. */
export interface VisibleConnection {
  id: string;
  connector_id: string;
  label: string;
  /** Granted capability ids as stored; '*' means every query capability. */
  granted: string[];
}

/** The grant this client holds for a connection that still exists, if any. */
export function findGrantedConnection(
  clientId: string,
  connectionId: string,
  auth: AuthStore,
  connections: ConnectionStore,
): { grant: Grant; connection: Connection } | undefined {
  const grant = auth.getGrants(clientId).find((g) => g.connection_id === connectionId);
  if (grant === undefined || grant.capabilities.length === 0) return undefined;
  const connection = connections.get(connectionId);
  if (connection === undefined) return undefined;
  return { grant, connection };
}

/** Every connection the client holds a grant for. Grants on deleted connections are skipped. */
export function listGrantedConnections(
  clientId: string,
  auth: AuthStore,
  connections: ConnectionStore,
): VisibleConnection[] {
  const out: VisibleConnection[] = [];
  for (const grant of auth.getGrants(clientId)) {
    if (grant.capabilities.length === 0) continue;
    const connection = connections.get(grant.connection_id);
    if (connection === undefined) continue;
    out.push({
      id: connection.id,
      connector_id: connection.connector_id,
      label: connection.label,
      granted: [...grant.capabilities],
    });
  }
  return out;
}

/**
 * Capabilities of the connection that the grant covers, with `support`
 * replaced by the connection's current state. '*' covers every query
 * capability (matching Grant's definition); actions must be granted by id.
 */
export function listGrantedCapabilities(
  grant: Grant,
  connection: Connection,
  all: Capability[],
): Capability[] {
  const wildcard = grant.capabilities.includes('*');
  return all
    .filter((cap) => isCapabilityRoleAllowed(connection, cap) && ((wildcard && cap.kind === 'query') || grant.capabilities.includes(cap.id) || (cap.kind === 'action' && grant.capabilities.includes(`propose:${cap.id}`))))
    .map((cap) => ({ ...cap, support: effectiveCapabilityState(cap, connection.capability_states[cap.id]) }));
}
