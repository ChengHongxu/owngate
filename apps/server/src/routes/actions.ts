import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticateClient, extractBearerToken } from './client-scope.js';
import type { InvokeOptions, InvokeServices } from '@owngate/core';
import { ActionError, type ActionCaller, type ActionService } from '../actions/service.js';

export async function registerActionRoutes(app: FastifyInstance, deps: {
  actions: ActionService; services: InvokeServices; invokeOpts: InvokeOptions;
  getAdminUserId: (request: FastifyRequest) => Promise<string | null>;
  approvalMethod: (request: FastifyRequest) => Promise<'passkey' | 'totp' | null>;
}) {
  for (const prefix of ['/api', '/admin']) {
    const admin = prefix === '/admin';
    const caller = async (req: FastifyRequest): Promise<ActionCaller> => {
      if (admin) {
        const user = await deps.getAdminUserId(req);
        if (!user) throw new ActionError('UNAUTHENTICATED', '请登录后台', 401);
        return { kind: 'admin', user_id: user };
      }
      const auth = authenticateClient(extractBearerToken(req.headers.authorization), deps.services.auth, deps.invokeOpts.hashToken);
      if (!auth.ok) throw new ActionError(auth.error.code, auth.error.message, 401);
      return { kind: 'client', client_id: auth.client.id };
    };
    const run = (fn: (req: FastifyRequest) => Promise<unknown>) => async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
      try { return await fn(req); } catch (e) {
        if (e instanceof ActionError) return reply.status(e.status).send({ code: e.code, error: e.message });
        req.log.error({ err: 'Action operation failed' });
        return reply.status(500).send({ code: 'INTERNAL_ERROR', error: '提案操作失败，请稍后重试' });
      }
    };
    app.get(`${prefix}/proposals`, run(async (req) => ({ proposals: await deps.actions.list(await caller(req)) })));
    app.post(`${prefix}/proposals`, { schema: { body: { type: 'object', additionalProperties: false, required: ['connection_id', 'capability_id'], properties: { connection_id: { type: 'string' }, capability_id: { type: 'string' }, input: { type: 'object' } } } } }, run(async (req) => {
      const body = req.body as { connection_id: string; capability_id: string; input?: unknown };
      return deps.actions.submit({ ...body, input: body.input ?? {} }, await caller(req));
    }));
    app.get(`${prefix}/proposals/:id`, run(async (req) => deps.actions.get((req.params as { id: string }).id, await caller(req))));
    app.patch(`${prefix}/proposals/:id`, { schema: { body: { type: 'object', additionalProperties: false, required: ['input'], properties: { input: { type: 'object' } } } } }, run(async (req) => deps.actions.update((req.params as { id: string }).id, (req.body as { input: unknown }).input, await caller(req))));
    app.post(`${prefix}/proposals/:id/execute`, run(async (req) => deps.actions.execute((req.params as { id: string }).id, await caller(req))));
    app.post(`${prefix}/actions/pause`, run(async (req) => deps.actions.pause(await caller(req))));
  }
  app.post('/admin/proposals/:id/approve', { config: { stepUp: true }, schema: { body: { type: 'object', additionalProperties: false, required: ['hash'], properties: { hash: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } } }, async (req, reply) => {
    const user = await deps.getAdminUserId(req), method = await deps.approvalMethod(req);
    if (!user || !method) return reply.status(403).send({ code: 'STEP_UP_REQUIRED', error: '批准需要重新验证身份；已注册 Passkey 时必须使用 Passkey' });
    try { return await deps.actions.approve((req.params as { id: string }).id, (req.body as { hash: string }).hash, user, method); }
    catch (e) { if (e instanceof ActionError) return reply.status(e.status).send({ code: e.code, error: e.message }); throw e; }
  });
  app.post('/admin/proposals/:id/reject', async (req, reply) => {
    const user = await deps.getAdminUserId(req);
    if (!user) return reply.status(401).send({ code: 'UNAUTHENTICATED' });
    try { return await deps.actions.reject((req.params as { id: string }).id, { kind: 'admin', user_id: user }); }
    catch (e) { if (e instanceof ActionError) return reply.status(e.status).send({ code: e.code, error: e.message }); throw e; }
  });
}
