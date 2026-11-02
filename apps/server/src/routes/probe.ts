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
   * Admin-session check (§8.4). Required: there is no default that lets a
   * request through. In the full server the central gate (createAdminGate)
   * has already answered 401 before this runs; this check keeps the module
   * safe when it is mounted on its own.
   */
  requireAdmin: (request: FastifyRequest) => Promise<boolean>;
}

const NO_SESSION = { error: 'Not authenticated', code: 'NO_SESSION' };

export async function registerProbeRoutes(app: FastifyInstance, deps: ProbeRouteDeps): Promise<void> {
  const { scheduler, requireAdmin } = deps;

  const allowed = (request: FastifyRequest): Promise<boolean> => requireAdmin(request);

  app.post<{ Params: { connectionId: string } }>(
    '/admin/probe/:connectionId',
    async (request, reply) => {
      if (!(await allowed(request))) return reply.status(401).send(NO_SESSION);
      const [result] = await scheduler.runOnce(request.params.connectionId);
      if (result === undefined || result.status === 'not_found') {
        return reply.status(404).send({ code: 'NOT_FOUND', what_happened: 'connection not found' });
      }
      return result;
    },
  );

  app.post('/admin/probe', async (request, reply) => {
    if (!(await allowed(request))) return reply.status(401).send(NO_SESSION);
    return scheduler.runOnce();
  });

  app.get('/admin/probe/status', async (request, reply) => {
    if (!(await allowed(request))) return reply.status(401).send(NO_SESSION);
    return scheduler.getStatus();
  });
}
