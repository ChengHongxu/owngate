import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ComparisonError, type ComparisonService } from '../comparisons/service.js';

export async function registerComparisonRoutes(app: FastifyInstance, deps: { service: ComparisonService; getAdminUserId: (request: FastifyRequest) => Promise<string | null> }): Promise<void> {
  type Params = { id: string; viewId: string; itemId: string };
  const prefix = '/admin/connections/:id/views/:viewId';
  const stepUp = { config: { stepUp: true } };
  async function handle(operation: () => Promise<unknown>, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ComparisonError) return reply.code(error.status).send({ code: error.code, error: error.message });
      return reply.code(500).send({ code: 'COMPARISON_SERVICE_ERROR', error: '比较操作失败，请检查连接状态与审计记录' });
    }
  }
  app.get<{ Params: Params }>(`${prefix}/links`, async (request, reply) => handle(async () => ({ links: await deps.service.listLinks(request.params.id, request.params.viewId) }), reply));
  app.put<{ Params: Params; Body: { target_connection_id: string } }>(`${prefix}/links/:itemId`, { ...stepUp,
    schema: { body: { type: 'object', additionalProperties: false, required: ['target_connection_id'], properties: { target_connection_id: { type: 'string', minLength: 1, maxLength: 100 } } } },
  }, async (request, reply) => {
    const userId = await deps.getAdminUserId(request);
    if (!userId) return reply.code(401).send({ code: 'NO_SESSION' });
    return handle(() => deps.service.setLink(request.params.id, request.params.viewId, request.params.itemId, request.body.target_connection_id, userId), reply);
  });
  app.delete<{ Params: Params }>(`${prefix}/links/:itemId`, stepUp, async (request, reply) => handle(async () => {
    await deps.service.deleteLink(request.params.id, request.params.viewId, request.params.itemId); return { ok: true };
  }, reply));
  app.post<{ Params: Params; Body: { input: Record<string, unknown> } }>(`${prefix}/run`, { ...stepUp,
    schema: { body: { type: 'object', required: ['input'], additionalProperties: false, properties: { input: { type: 'object', maxProperties: 100 } } } },
  }, async (request, reply) => {
    const userId = await deps.getAdminUserId(request);
    if (!userId) return reply.code(401).send({ code: 'NO_SESSION' });
    return handle(() => deps.service.run(request.params.id, request.params.viewId, request.body.input, userId), reply);
  });
}
