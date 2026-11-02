// REST entry point — /api/invoke and /api/tasks
import type { FastifyInstance } from 'fastify';
import type { InvokeServices, InvokeOptions } from '@webridge/core';
import { invoke } from '@webridge/core';
import type { DbClient } from '@webridge/db';
import type { Vault } from '@webridge/vault';

interface RestDeps {
  services: InvokeServices;
  invokeOpts: InvokeOptions;
  db: DbClient;
  vault: Vault;
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

    const envelope = await invoke(
      {
        token,
        connection_id: request.body.connection_id,
        capability_id: request.body.capability_id,
        input: request.body.input ?? {},
        ...(request.body.no_cache !== undefined ? { no_cache: request.body.no_cache } : {}),
      },
      deps.services,
      deps.invokeOpts,
    );

    const status = envelope.outcome === 'error' ? errorStatus(envelope.error?.code) : 200;
    return reply.status(status).send(envelope);
  });

  // GET /api/tasks/:id
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const token = extractToken(request.headers['authorization']);
    if (!token) return reply.status(401).send({ error: 'Missing Authorization header' });
    const task = await deps.db.getTask(request.params.id);
    if (!task) return reply.status(404).send({ error: 'Task not found' });
    return reply.send(task);
  });
}

function extractToken(auth: string | undefined): string | null {
  if (!auth) return null;
  const [scheme, token] = auth.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

function errorStatus(code: string | undefined): number {
  switch (code) {
    case 'UNAUTHORIZED':
    case 'CLIENT_REVOKED': return 401;
    case 'FORBIDDEN': return 403;
    case 'CONNECTION_NOT_FOUND':
    case 'CAPABILITY_NOT_FOUND': return 404;
    case 'INVALID_INPUT': return 400;
    default: return 500;
  }
}
