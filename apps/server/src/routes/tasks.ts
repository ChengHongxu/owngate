import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { err } from '@owngate/core';
import type { InvokeOptions, InvokeRequest, InvokeServices } from '@owngate/core';
import { TaskServiceError } from '../tasks/service.js';
import type { TaskCaller, TaskService } from '../tasks/service.js';
import { authenticateClient, extractBearerToken } from './client-scope.js';

export interface TaskRoutesDeps {
  tasks: TaskService;
  services: InvokeServices;
  invokeOpts: InvokeOptions;
  getAdminUserId?: (request: FastifyRequest) => string | null | Promise<string | null>;
}

const submissionSchema = {
  type: 'object', required: ['connection_id', 'capability_id'], additionalProperties: false,
  properties: { connection_id: { type: 'string', minLength: 1 }, capability_id: { type: 'string', minLength: 1 },
    input: {}, no_cache: { type: 'boolean' } },
} as const;

export async function registerTaskRoutes(app: FastifyInstance, deps: TaskRoutesDeps): Promise<void> {
  for (const prefix of ['/api/tasks', '/admin/tasks']) {
    const admin = prefix.startsWith('/admin');
    const caller = async (request: FastifyRequest, reply: FastifyReply): Promise<TaskCaller | null> => {
      if (admin) {
        const userId = await deps.getAdminUserId?.(request);
        if (userId) return { kind: 'admin', user_id: userId };
        reply.status(401).send({ error: err('UNAUTHENTICATED', 'Admin session required') });
        return null;
      }
      const auth = authenticateClient(extractBearerToken(request.headers.authorization), deps.services.auth, deps.invokeOpts.hashToken);
      if (auth.ok) return { kind: 'client', client_id: auth.client.id };
      reply.status(401).send({ error: auth.error });
      return null;
    };
    const guarded = async (request: FastifyRequest, reply: FastifyReply, action: (actor: TaskCaller) => Promise<unknown>): Promise<unknown> => {
      const actor = await caller(request, reply);
      if (!actor) return reply;
      try { return await action(actor); }
      catch (error) {
        if (error instanceof TaskServiceError) return reply.status(error.statusCode).send({ error: error.error });
        return reply.status(500).send({ error: err('INTERNAL_ERROR', 'Task operation could not be completed') });
      }
    };
    // Authenticate before schema validation to avoid describing APIs to an
    // unknown client. The handler and service recheck current identity too.
    const authenticate = async (request: FastifyRequest, reply: FastifyReply) => { await caller(request, reply); };

    app.post<{ Body: Omit<InvokeRequest, 'token'> }>(prefix, { onRequest: authenticate, schema: { body: submissionSchema } },
      async (request, reply) => guarded(request, reply, async (actor) => {
        const submitted = await deps.tasks.submit({ connection_id: request.body.connection_id,
          capability_id: request.body.capability_id, input: request.body.input ?? {},
          ...(request.body.no_cache !== undefined ? { no_cache: request.body.no_cache } : {}) }, actor);
        return reply.status(202).send(submitted);
      }));
    app.get<{ Querystring: { limit?: string; before?: string } }>(prefix, { onRequest: authenticate },
      async (request, reply) => guarded(request, reply, async (actor) => ({ tasks: await deps.tasks.list(actor, {
        ...(request.query.limit !== undefined ? { limit: Number(request.query.limit) || 50 } : {}),
        ...(request.query.before !== undefined ? { before: request.query.before } : {}),
      }) })));
    app.get<{ Params: { id: string } }>(`${prefix}/:id`, { onRequest: authenticate },
      async (request, reply) => guarded(request, reply, (actor) => deps.tasks.get(request.params.id, actor)));
    app.get<{ Params: { id: string }; Querystring: { after?: string } }>(`${prefix}/:id/events`, { onRequest: authenticate },
      async (request, reply) => guarded(request, reply, async (actor) => ({ events: await deps.tasks.events(request.params.id, actor, Number(request.query.after) || 0) })));
    app.post<{ Params: { id: string } }>(`${prefix}/:id/cancel`, { onRequest: authenticate },
      async (request, reply) => guarded(request, reply, (actor) => deps.tasks.cancel(request.params.id, actor)));
  }
}
