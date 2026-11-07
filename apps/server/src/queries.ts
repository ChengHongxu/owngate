import { invoke, type InvokeOptions, type InvokeServices, type ResultEnvelope } from '@owngate/core';
import { authenticateClient, listGrantedConnections } from './routes/client-scope.js';

export interface AggregateRequest { connection_ids?: string[] | undefined; capability_id: string; input?: unknown; no_cache?: boolean | undefined; all?: boolean | undefined; tag?: string | undefined }
export async function queryConnections(req: AggregateRequest, deps: {
  services: InvokeServices; invokeOpts: InvokeOptions; listConnectionIds: () => string[];
}, caller: { token: string } | { user_id: string }) {
  let ids: string[];
  const explicit = req.connection_ids && req.connection_ids.length > 0;
  if ('token' in caller) {
    const auth = authenticateClient(caller.token, deps.services.auth, deps.invokeOpts.hashToken);
    if (!auth.ok) return { envelope_version: 2, status: 'forbidden', results: [], error: auth.error };
    ids = explicit ? req.connection_ids! : listGrantedConnections(auth.client.id, deps.services.auth, deps.services.connections).map((c) => c.id);
  } else ids = explicit ? req.connection_ids! : deps.listConnectionIds();
  ids = [...new Set(ids)].filter((id) => {
    const c = deps.services.connections.get(id);
    if (!explicit && c?.scope === 'organization') return false;
    // Automatic social aggregation only includes connections with a feed
    // implementation. Explicit ids retain their own unsupported/error result.
    if (!explicit && req.capability_id === 'feed.list' && (!c || !deps.services.capabilities.get(c.connector_id, 'feed.list'))) return false;
    return !req.tag || c?.tags?.includes(req.tag);
  }).slice(0, 100);
  const results = await Promise.all(ids.map((connection_id) => invoke({
    ...('token' in caller ? { token: caller.token } : {}), connection_id, capability_id: req.capability_id,
    input: req.input ?? {}, ...(req.no_cache !== undefined ? { no_cache: req.no_cache } : {}),
  }, deps.services, deps.invokeOpts, 'user_id' in caller ? { kind: 'admin', user_id: caller.user_id } : undefined)));
  const status = aggregateStatus(results);
  return { envelope_version: 2, status, requested_at: new Date().toISOString(), results };
}

export function aggregateStatus(results: ResultEnvelope[]) {
  return results.length === 0 || results.every((r) => r.outcome === 'success') ? 'ok' : results.every((r) => r.outcome === 'error') ? 'error' : 'partial';
}

/** Only filters the items actually fetched; an unknown timestamp stays visible. */
export function filterFeedSince(results: ResultEnvelope[], since: string | undefined, now = Date.now()) {
  if (!since) return { results, filter: null };
  const match = /^(\d+)(m|h|d)$/.exec(since);
  if (!match) throw new Error('Invalid feed window');
  const duration = Number(match[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!] ?? 0);
  if (!(duration > 0 && duration <= 365 * 86_400_000)) throw new Error('Feed window must be between one minute and 365 days');
  const cutoff = new Date(now - duration).toISOString();
  let unknown = 0;
  const filtered = results.map((result) => {
    const data = result.data as { items?: unknown[] } | null;
    if (!Array.isArray(data?.items)) return result;
    let unknownHere = 0;
    const items = data.items.filter((item) => {
      const published = typeof item === 'object' && item !== null ? (item as { published_at?: unknown }).published_at : undefined;
      const time = typeof published === 'string' ? Date.parse(published) : NaN;
      if (!Number.isFinite(time)) { unknownHere++; return true; }
      return time >= now - duration;
    });
    unknown += unknownHere;
    return { ...result, data: { ...data, items }, warnings: [...result.warnings, '时间筛选仅作用于本次取得的条目，不代表完整历史', ...(unknownHere ? [`${unknownHere} 条内容的发布时间未知，已保留并标记未筛选`] : [])] };
  });
  return { results: filtered, filter: { since: cutoff, applied: 'local' as const, unknown_time_items: unknown, not_exhaustive: true } };
}

export function aggregateFeed(results: ResultEnvelope[]) {
  return results.flatMap((result) => {
    const data = result.data as { items?: unknown[] } | null;
    return (Array.isArray(data?.items) ? data.items : []).map((item) => ({ source: result.source, item }));
  });
}
