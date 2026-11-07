// REST entry point — /api/invoke and /api/tasks
import type { FastifyInstance } from 'fastify';
import type { ErrorCode, InvokeServices, InvokeOptions } from '@owngate/core';
import { err, fail, invoke } from '@owngate/core';
import { authenticateClient } from './client-scope.js';
import { TaskServiceError } from '../tasks/service.js';
import type { TaskService } from '../tasks/service.js';
import { effectiveCapabilityState } from '../connection-status.js';

interface RestDeps {
  services: InvokeServices;
  invokeOpts: InvokeOptions;
  tasks?: TaskService;
}

export async function registerRestRoutes(app: FastifyInstance, deps: RestDeps) {
  // POST /api/invoke — single capability call
  app.post<{
    Body: { connection_id: string; capability_id: string; input?: unknown; no_cache?: boolean };
  }>('/api/invoke', {
    schema: {
      body: {
        type: 'object',
        required: ['connection_id', 'capability_id'],
        properties: {
          connection_id: { type: 'string' },
          capability_id: { type: 'string' },
          input: {},
          no_cache: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const token = extractToken(request.headers['authorization']);
    if (!token) return reply.status(401).send({ error: 'Missing Authorization header' });

    // Prefer is negotiated only after current authentication and grant checks.
    // A timeout on the synchronous path never causes a second submission.
    const prefer = request.headers['prefer'];
    const respondAsync = typeof prefer === 'string' && prefer.split(',').some((value) => /^respond-async(?:\s*;|\s*$)/i.test(value.trim()));
    if (respondAsync && deps.tasks) {
      const auth = authenticateClient(token, deps.services.auth, deps.invokeOpts.hashToken);
      if (auth.ok) {
        const grant = deps.services.auth.getGrants(auth.client.id).find((item) => item.connection_id === request.body.connection_id);
        const connection = grant && deps.services.connections.get(request.body.connection_id);
        const capability = connection && deps.services.capabilities.get(connection.connector_id, request.body.capability_id);
        const granted = capability && (grant!.capabilities.includes(capability.id) || (grant!.capabilities.includes('*') && capability.kind === 'query'));
        if (connection && capability?.long_running && granted) {
          try {
            const ticket = await deps.tasks.submit({ connection_id: connection.id, capability_id: capability.id,
              input: Object.hasOwn(request.body, 'input') ? request.body.input : {}, ...(request.body.no_cache !== undefined ? { no_cache: request.body.no_cache } : {}) },
            { kind: 'client', client_id: auth.client.id });
            return reply.header('Preference-Applied', 'respond-async').status(202).send(ticket);
          } catch (error) {
            const apiError = error instanceof TaskServiceError ? error.error : err('INTERNAL_ERROR', 'Task submission could not be completed');
            const envelope = fail(apiError, { connection_id: connection.id, connection_label: connection.label,
              capability_id: capability.id, support: effectiveCapabilityState(capability, connection.capability_states[capability.id]) });
            return reply.status(error instanceof TaskServiceError ? error.statusCode : 500).send(deps.invokeOpts.sanitize?.(envelope) ?? envelope);
          }
        }
      }
    }

    const envelope = await invoke(
      {
        token,
        connection_id: request.body.connection_id,
        capability_id: request.body.capability_id,
        input: Object.hasOwn(request.body, 'input') ? request.body.input : {},
        ...(request.body.no_cache !== undefined ? { no_cache: request.body.no_cache } : {}),
      },
      deps.services,
      deps.invokeOpts,
    );

    const status = envelope.outcome === 'error' ? errorStatus(envelope.error?.code) : 200;
    return reply.status(status).send(envelope);
  });
}

function extractToken(auth: string | undefined): string | null {
  if (!auth) return null;
  const [scheme, token] = auth.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

function errorStatus(code: ErrorCode | undefined): number {
  switch (code) {
    case 'UNAUTHENTICATED':
    case 'CLIENT_REVOKED': return 401;
    case 'PERMISSION_DENIED': return 403;
    case 'CONNECTION_NOT_FOUND':
    case 'CAPABILITY_NOT_FOUND': return 404;
    case 'INVALID_PARAMS': return 400;
    default: return 500;
  }
}
