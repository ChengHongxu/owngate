import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DbClient } from '@owngate/db';
import type { Connection, InvokeOptions, InvokeServices } from '@owngate/core';
import type { BrowserClient } from '../browser-client.js';
import { aggregateFeed, aggregateStatus, filterFeedSince, queryConnections, type AggregateRequest } from '../queries.js';
import { authenticateClient, extractBearerToken } from './client-scope.js';
import type { ConnectorRegistry } from '../registry.js';
import { connectionHealth, connectionView } from '../connection-status.js';

export async function registerProductRoutes(app: FastifyInstance, deps: {
  db: DbClient; services: InvokeServices; invokeOpts: InvokeOptions; connections: Map<string, Connection>;
  connectorRegistry: Pick<ConnectorRegistry, 'getManifest' | 'listCapabilities'>;
  browser: BrowserClient; getAdminUserId: (req: FastifyRequest) => Promise<string | null>;
  invalidate: () => Promise<void>;
  cancelConnection?: (id: string) => Promise<unknown>;
  resetLimits?: (id: string) => void;
  notifyChanged?: () => Promise<void>;
}) {
  const querySchema = { type: 'object', additionalProperties: false, required: ['capability_id'], properties: {
    connection_ids: { type: 'array', maxItems: 100, items: { type: 'string' } }, capability_id: { type: 'string' },
    input: { type: 'object' }, no_cache: { type: 'boolean' }, all: { type: 'boolean' }, tag: { type: 'string' },
  } };
  for (const prefix of ['/api', '/admin']) {
    app.post<{ Body: AggregateRequest }>(`${prefix}/query`, { schema: { body: querySchema } }, async (req, reply) => {
      const user = prefix === '/admin' ? await deps.getAdminUserId(req) : null;
      const token = prefix === '/api' ? extractBearerToken(req.headers.authorization) : null;
      if (!user && !token) return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: '请先登录或提供客户端令牌' } });
      return queryConnections(req.body, { services: deps.services, invokeOpts: deps.invokeOpts, listConnectionIds: () => [...deps.connections.keys()] }, user ? { user_id: user } : { token: token! });
    });
    app.post<{ Body: Omit<AggregateRequest, 'capability_id'> & { since?: string } }>(`${prefix}/feed`, { schema: { body: { type: 'object', additionalProperties: false, properties: {
      connection_ids: querySchema.properties.connection_ids, input: { type: 'object' }, tag: { type: 'string' }, all: { type: 'boolean' }, no_cache: { type: 'boolean' }, since: { type: 'string', pattern: '^[1-9][0-9]{0,4}(m|h|d)$' },
    } } } }, async (req, reply) => {
      const user = prefix === '/admin' ? await deps.getAdminUserId(req) : null;
      const token = prefix === '/api' ? extractBearerToken(req.headers.authorization) : null;
      if (!user && !token) return reply.status(401).send({ code: 'UNAUTHENTICATED' });
      const body = req.body ?? {};
      let filter: ReturnType<typeof filterFeedSince>;
      try { filter = filterFeedSince([], body.since); }
      catch { return reply.status(400).send({ code: 'INVALID_PARAMS', error: '时间范围应为 1m 到 365d，如 6h' }); }
      const result = await queryConnections({ ...body, capability_id: 'feed.list' }, { services: deps.services, invokeOpts: deps.invokeOpts, listConnectionIds: () => [...deps.connections.keys()] }, user ? { user_id: user } : { token: token! });
      filter = filterFeedSince(result.results, body.since);
      return { ...result, ...filter, status: result.status === 'forbidden' ? 'forbidden' : aggregateStatus(filter.results), items: aggregateFeed(filter.results) };
    });
  }
  app.patch<{ Params: { id: string }; Body: { paused?: boolean; scope?: 'personal' | 'organization'; tags?: string[]; confirm_organization?: boolean } }>('/admin/connections/:id/state', {
    config: { stepUp: true }, schema: { body: { type: 'object', additionalProperties: false, properties: {
      paused: { type: 'boolean' }, scope: { type: 'string', enum: ['personal', 'organization'] }, tags: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 40 } }, confirm_organization: { type: 'boolean' },
    } } },
  }, async (req, reply) => {
    const c = deps.connections.get(req.params.id);
    if (!c) return reply.status(404).send({ code: 'CONNECTION_NOT_FOUND' });
    if (req.body.scope === 'organization' && !req.body.confirm_organization) return reply.status(400).send({ code: 'ORGANIZATION_CONFIRMATION_REQUIRED', error: '请确认有权接入此组织账户' });
    const paused = req.body.paused ?? c.paused ?? false, scope = req.body.scope ?? c.scope ?? 'personal', tags = [...new Set(req.body.tags ?? c.tags ?? [])];
    // Clearing the worker's risk pause is an explicit admin action protected
    // by step-up. A failed worker call leaves the connection paused.
    if (req.body.paused === false && deps.browser.resumeSafety && deps.services.capabilities.list?.(c.connector_id).some((cap) => cap.transport === 'browser')) {
      try { const resumed = await deps.browser.resumeSafety(c.id); if (!resumed.ok) throw new Error('Resume rejected'); }
      catch { return reply.status(502).send({ code: 'UPSTREAM_ERROR', error: '浏览器未确认恢复，请稍后重试；连接仍保持原状态' }); }
    }
    const revision = new Date().toISOString(), newlyOrganizational = scope === 'organization' && c.scope !== 'organization';
    await deps.db.rawTransaction([
      { sql: 'UPDATE connections SET paused=?,scope=?,tags=?,updated_at=? WHERE id=?', params: [paused ? 1 : 0, scope, JSON.stringify(tags), revision, c.id] },
      ...(newlyOrganizational ? [{ sql: 'DELETE FROM grants WHERE connection_id=?', params: [c.id] }] : []),
    ]);
    c.paused = paused; c.scope = scope; c.tags = tags; c.updated_at = revision;
    if (newlyOrganizational) {
      // Remove the same grants in memory, so current authorization changes now.
      for (const g of await deps.db.listClients()) {
        const current = deps.services.auth.getGrants(g.id);
        const i = current.findIndex((grant) => grant.connection_id === c.id); if (i >= 0) current.splice(i, 1);
      }
    }
    await deps.invalidate();
    if (paused) { await deps.cancelConnection?.(c.id); await deps.browser.closeSession(c.id).catch(() => undefined); }
    if (req.body.paused === false) deps.resetLimits?.(c.id);
    await deps.services.audit.append({ action: req.body.paused === false ? 'connection.resumed' : paused ? 'connection.paused' : 'connection.settings', client_id: undefined, target: c.id, detail: { scope, tags, paused, actor: await deps.getAdminUserId(req) } });
    await deps.notifyChanged?.();
    return connectionView(c, deps.connectorRegistry);
  });
  app.get<{ Querystring: { before?: string; limit?: string; client_id?: string; connection_id?: string } }>('/admin/audit', async (req) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const filters: string[] = [], params: unknown[] = [];
    if (req.query.before) { filters.push('seq < ?'); params.push(Number(req.query.before) || 0); }
    if (req.query.client_id) { filters.push('client_id = ?'); params.push(req.query.client_id); }
    if (req.query.connection_id) { filters.push('target = ?'); params.push(req.query.connection_id); }
    const rows = await deps.db.rawQuery(`SELECT * FROM audit_log ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`, [...params, limit]);
    return { entries: deps.invokeOpts.sanitize?.(rows) ?? rows };
  });
  app.get('/admin/overview', async () => {
    const [tasks, proposals, alerts] = await Promise.all([
      deps.db.rawQuery(`SELECT id,connection_id,capability_id,status,created_at FROM tasks ORDER BY created_at DESC LIMIT 5`),
      deps.db.rawQuery(`SELECT count(*) AS count FROM action_proposals WHERE status='pending'`),
      deps.db.rawQuery(`SELECT seq,action,target,at FROM audit_log WHERE action LIKE 'monitor.%' ORDER BY seq DESC LIMIT 5`),
    ]);
    return { connections: [...deps.connections.values()].map(connection => ({ id: connection.id, label: connection.label,
      paused: connection.paused ?? false, health: connectionHealth(connection, deps.connectorRegistry) })),
      tasks, pending_proposals: (proposals[0] as { count: number })?.count ?? 0, alerts, actions_enabled: false };
  });
  // Clients have no management or approval route. This merely authenticates
  // their ability to request the global stop through ActionService elsewhere.
  app.get('/api/session', async (req, reply) => {
    const auth = authenticateClient(extractBearerToken(req.headers.authorization), deps.services.auth, deps.invokeOpts.hashToken);
    return auth.ok ? { id: auth.client.id, label: auth.client.label } : reply.status(401).send({ error: auth.error });
  });
}
