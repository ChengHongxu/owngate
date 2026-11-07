// Client-token read-only listing (design §8.4, §9.2):
//
//   GET /api/connections                    connections this token is granted
//   GET /api/connections/:id/capabilities   granted capabilities of one of them
//
// Bearer client token, never the admin session. The CLI's `conn ls` / `cap ls`
// use these; MCP list_connections uses the same filter (client-scope.ts).
// Failures use the envelope's error object: 401 UNAUTHENTICATED / CLIENT_REVOKED
// like /api/invoke, and 404 CONNECTION_NOT_FOUND both for an unknown id and for
// a connection the token has no grant for, so a token cannot probe for ids.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { err } from '@owngate/core';
import type { ApiError, AuthStore, Capability, ConnectionStore } from '@owngate/core';
import {
  authenticateClient,
  extractBearerToken,
  findGrantedConnection,
  listGrantedCapabilities,
  listGrantedConnections,
} from './client-scope.js';

export interface ClientApiDeps {
  auth: AuthStore;
  connections: ConnectionStore;
  hashToken: (token: string) => string;
  /** All capabilities a connector declares (the registry's listCapabilities). */
  listCapabilities: (connectorId: string) => Capability[];
}

function sendError(reply: FastifyReply, error: ApiError): FastifyReply {
  const status = error.code === 'CONNECTION_NOT_FOUND' ? 404 : 401;
  return reply.status(status).send({ error });
}

export async function registerClientApiRoutes(app: FastifyInstance, deps: ClientApiDeps): Promise<void> {
  app.get('/api/connections', async (request, reply) => {
    const authn = authenticateClient(extractBearerToken(request.headers.authorization), deps.auth, deps.hashToken);
    if (!authn.ok) return sendError(reply, authn.error);
    return { connections: listGrantedConnections(authn.client.id, deps.auth, deps.connections) };
  });

  app.get<{ Params: { id: string } }>('/api/connections/:id/capabilities', async (request, reply) => {
    const authn = authenticateClient(extractBearerToken(request.headers.authorization), deps.auth, deps.hashToken);
    if (!authn.ok) return sendError(reply, authn.error);

    const { id } = request.params;
    const found = findGrantedConnection(authn.client.id, id, deps.auth, deps.connections);
    if (found === undefined) {
      return sendError(reply, err('CONNECTION_NOT_FOUND', `Connection ${id} not found`));
    }
    const all = deps.listCapabilities(found.connection.connector_id);
    return {
      connection_id: found.connection.id,
      capabilities: listGrantedCapabilities(found.grant, found.connection, all),
    };
  });
}
