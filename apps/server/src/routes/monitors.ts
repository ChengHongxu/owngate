import type { FastifyInstance } from 'fastify';
import { MonitorError } from '../monitors/types.js';
import type { MonitorService } from '../monitors/service.js';

/** main.ts's root admin gate covers reads; all mutations/external sends step up. */
export async function registerMonitorRoutes(app: FastifyInstance, deps: { service: MonitorService }): Promise<void> {
  const service = deps.service;
  const sensitive = { config: { stepUp: true } };
  const run = async <T>(operation: () => Promise<T>, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): Promise<unknown> => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof MonitorError) return reply.code(error.status).send({ code: error.code, error: error.message });
      // DB/SMTP exceptions may contain credentials or input values.
      return reply.code(500).send({ code: 'MONITOR_SERVICE_ERROR', error: '监控操作失败，请重试或查看审计记录' });
    }
  };
  app.get('/admin/notification-channels', async (_request, reply) => run(async () => ({ channels: await service.listChannels() }), reply));
  app.post('/admin/notification-channels', sensitive, async (request, reply) => run(async () => { const channel = await service.createChannel(request.body); reply.code(201); return channel; }, reply));
  app.put<{ Params: { id: string } }>('/admin/notification-channels/:id', sensitive, async (request, reply) => run(() => service.updateChannel(request.params.id, request.body), reply));
  app.delete<{ Params: { id: string } }>('/admin/notification-channels/:id', sensitive, async (request, reply) => run(async () => { await service.deleteChannel(request.params.id); return { ok: true }; }, reply));
  app.post<{ Params: { id: string } }>('/admin/notification-channels/:id/test', sensitive, async (request, reply) => run(() => service.testChannel(request.params.id), reply));
  app.get('/admin/monitors', async (_request, reply) => run(async () => ({ monitors: await service.listMonitors() }), reply));
  app.post('/admin/monitors', sensitive, async (request, reply) => run(async () => { const monitor = await service.createMonitor(request.body); reply.code(201); return monitor; }, reply));
  app.put<{ Params: { id: string } }>('/admin/monitors/:id', sensitive, async (request, reply) => run(() => service.updateMonitor(request.params.id, request.body), reply));
  app.patch<{ Params: { id: string }; Body: { enabled: boolean } }>('/admin/monitors/:id', {
    ...sensitive,
    schema: { body: { type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' } } } },
  }, async (request, reply) => run(() => service.setEnabled(request.params.id, request.body.enabled), reply));
  app.delete<{ Params: { id: string } }>('/admin/monitors/:id', sensitive, async (request, reply) => run(async () => { await service.deleteMonitor(request.params.id); return { ok: true }; }, reply));
  app.post<{ Params: { id: string } }>('/admin/monitors/:id/run', sensitive, async (request, reply) => run(() => service.run(request.params.id), reply));
}
