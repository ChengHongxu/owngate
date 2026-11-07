import type { FastifyInstance } from 'fastify';
import { ExtensionError, type ExtensionInput, type ExtensionService } from '../extensions/service.js';

const properties = {
  source: { type: 'string', minLength: 1, maxLength: 131072 },
  format: { type: 'string', enum: ['manifest', 'openapi'] },
  id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{2,63}$' },
};
export async function registerExtensionRoutes(app: FastifyInstance, deps: { service: ExtensionService }): Promise<void> {
  async function handle(operation: () => unknown | Promise<unknown>, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ExtensionError) return reply.code(error.status).send({ code: error.code, error: error.message });
      return reply.code(500).send({ code: 'EXTENSION_SERVICE_ERROR', error: '扩展操作失败，请查看审计记录并重试' });
    }
  }
  app.get('/admin/extensions', async () => ({ extensions: deps.service.list() }));
  app.post<{ Body: ExtensionInput }>('/admin/extensions/preview', {
    bodyLimit: 768 * 1024,
    schema: { body: { type: 'object', additionalProperties: false, required: ['source', 'format'], properties } },
  }, async (request, reply) => handle(() => deps.service.preview(request.body), reply));
  app.post<{ Body: ExtensionInput & { enabled_capabilities: string[]; preview_fingerprint: string } }>('/admin/extensions', {
    bodyLimit: 768 * 1024, config: { stepUp: true },
    schema: { body: { type: 'object', additionalProperties: false, required: ['source', 'format', 'enabled_capabilities', 'preview_fingerprint'], properties: { ...properties,
      enabled_capabilities: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 200 } },
      preview_fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    } } },
  }, async (request, reply) => handle(async () => { const result = await deps.service.install(request.body); reply.code(201); return result; }, reply));
}
