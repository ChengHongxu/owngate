import type { Capability, Connection } from '@owngate/core';
import { defaultInput, renderTemplate } from '@owngate/connector-runtime';
import type { HttpDefinition } from './types.js';

/** Resolve once using the same rules in the credential broker and the worker. */
export function resolveHttpUrl(
  connection: Connection,
  capability: Capability,
  input: unknown,
  http: HttpDefinition['http'],
  path: string,
  query: Record<string, string> = {},
): URL {
  const values = defaultInput(input, capability.input);
  const context = { config: connection.config, secret: {}, input: values };
  const base = renderTemplate(http.base, context);
  const route = renderTemplate(path, context, { urlEncodeInput: true });
  if (base.warnings.length || route.warnings.length) throw new Error('Invalid HTTP URL template');
  const origin = new URL(base.value), target = new URL(route.value, origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.hash || target.origin !== origin.origin || target.username || target.password || target.hash) {
    throw new Error('HTTP request must stay on the configured origin');
  }
  for (const [field, name] of Object.entries(query)) {
    const value = values[field];
    if (value === undefined || value === null) continue;
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error('HTTP query parameters must be scalar');
    target.searchParams.set(name, String(value));
  }
  return target;
}

/** Exact method/URL pairs. A grant for a balance query cannot read token APIs. */
export function authorizedHttpReads(connection: Connection, capability: Capability, input: unknown, definition: HttpDefinition): Set<string> {
  const method = definition.request.method;
  if (!['GET', 'HEAD', 'ADAPTER'].includes(method) || capability.kind !== 'query' || capability.effect !== 'read') throw new Error('HTTP writes are disabled');
  const reads = new Set<string>();
  const add = (verb: string, path: string, query?: Record<string, string>) => {
    reads.add(`${verb} ${resolveHttpUrl(connection, capability, input, definition.http, path, query).href}`);
  };
  add(method === 'ADAPTER' ? 'GET' : method, definition.request.path, definition.request.query);
  if (method === 'ADAPTER') {
    if ((definition.request.readonly_paths?.length ?? 0) > 10) throw new Error('Too many HTTP read paths');
    for (const path of definition.request.readonly_paths ?? []) add('GET', path);
  } else if (definition.discovery && Object.values(definition.output ?? {}).some(field => field.transform === 'quota_to_usd')) {
    add('GET', definition.discovery.quota_ratio.path);
  }
  return reads;
}
