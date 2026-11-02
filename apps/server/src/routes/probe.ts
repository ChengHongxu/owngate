// Admin probe routes — trigger and inspect login-state probes (design §4.4.3).
//
//   POST /admin/probe/:connectionId  probe one connection now
//   POST /admin/probe                probe every connection now
//   GET  /admin/probe/status         last run time and latest result per connection

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ProbeScheduler } from '../probe/scheduler.js';

export interface ProbeRouteDeps {
  scheduler: Pick<ProbeScheduler, 'runOnce' | 'getStatus'>;
  /**
   * Admin gate. When omitted every request is allowed: in M1 these routes sit
   * next to the other /admin routes, which are not gated yet either.
   * TODO(M1): main.ts must pass the real admin-session check here.
   */
  requireAdmin?: (request: FastifyRequest) => Promise<boolean>;
}

const UNAUTHORIZED = { code: 'UNAUTHORIZED' };

export async function registerProbeRoutes(app: FastifyInstance, deps: ProbeRouteDeps): Promise<void> {
  const { scheduler, requireAdmin } = deps;

  const allowed = async (request: FastifyRequest): Promise<boolean> =>
    requireAdmin === undefined ? true : requireAdmin(request);

  app.post<{ Params: { connectionId: string } }>(
    '/admin/probe/:connectionId',
    async (request, reply) => {
      if (!(await allowed(request))) return reply.status(401).send(UNAUTHORIZED);
      const [result] = await scheduler.runOnce(request.params.connectionId);
      if (result === undefined || result.status === 'not_found') {
        return reply.status(404).send({ code: 'NOT_FOUND', what_happened: 'connection not found' });
      }
      return result;
    },
  );

  app.post('/admin/probe', async (request, reply) => {
    if (!(await allowed(request))) return reply.status(401).send(UNAUTHORIZED);
    return scheduler.runOnce();
  });

  app.get('/admin/probe/status', async (request, reply) => {
    if (!(await allowed(request))) return reply.status(401).send(UNAUTHORIZED);
    return scheduler.getStatus();
  });
}
