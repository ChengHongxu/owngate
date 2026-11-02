// invoke() — the single execution gate for all capabilities.
// Every request from CLI, MCP, and the admin backend goes through here.
// Design doc §2.2.1: auth → policy/approval → cache → dispatch → redact → audit

import type {
  Capability,
  Connection,
  Client,
  Grant,
  SupportStatus,
} from '../types/index.js';
import { err } from '../errors/index.js';
import { fail, ok } from '../envelope/index.js';
import type { ResultEnvelope } from '../envelope/index.js';
import type { ApiError, ErrorCode } from '../errors/index.js';

// ── Interfaces that invoke() depends on (injected at startup) ─────────────

export interface CapabilityRegistry {
  get(connectorId: string, capabilityId: string): Capability | undefined;
}

export interface ConnectionStore {
  get(connectionId: string): Connection | undefined;
}

export interface AuthStore {
  getClient(tokenHash: string): Client | undefined;
  getGrants(clientId: string): Grant[];
}

export interface CacheStore {
  get(key: string): CachedResult | undefined;
  set(key: string, envelope: ResultEnvelope, ttl: number): void;
  invalidate(clientId: string): void;
}

export interface CachedResult {
  envelope: ResultEnvelope;
  cached_at: string;
  expires_at: string;
  ttl: number;
}

export interface AuditStore {
  append(entry: AuditEntry): void;
}

export interface AuditEntry {
  client_id: string | undefined;
  action: string;
  target: string | undefined;
  detail: unknown;
}

export interface Dispatcher {
  dispatch(
    connection: Connection,
    capability: Capability,
    input: unknown,
  ): Promise<ResultEnvelope>;
}

export interface InvokeServices {
  capabilities: CapabilityRegistry;
  connections: ConnectionStore;
  auth: AuthStore;
  cache: CacheStore;
  audit: AuditStore;
  dispatch: Dispatcher;
}

// ── Request & response types ──────────────────────────────────────────────

export interface InvokeRequest {
  token: string;
  connection_id: string;
  capability_id: string;
  input: unknown;
  no_cache?: boolean;
}

export interface InvokeOptions {
  /** Hash function to convert raw token to stored hash (injected to avoid crypto dep here) */
  hashToken: (token: string) => string;
  /** Redact function to apply to output (injected to avoid vault dep here) */
  redactOutput: (data: unknown, capability: Capability, clientKind: Client['kind']) => unknown;
}

// ── Cache key ─────────────────────────────────────────────────────────────

function cacheKey(connectionId: string, capabilityId: string, input: unknown): string {
  const payload = JSON.stringify({ c: connectionId, a: capabilityId, i: input });
  // Simple deterministic key — production uses SHA-256 hash (injected)
  return `${connectionId}:${capabilityId}:${Buffer.from ? Buffer.from(payload).toString('base64') : btoa(payload)}`;
}

// ── Main invoke() ─────────────────────────────────────────────────────────

/**
 * Single execution gate. Returns a ResultEnvelope regardless of outcome.
 * Never throws — errors are returned as envelopes with outcome: 'error'.
 */
export async function invoke(
  req: InvokeRequest,
  services: InvokeServices,
  opts: InvokeOptions,
): Promise<ResultEnvelope> {
  // ── 1. Authentication ─────────────────────────────────────────────────
  const tokenHash = opts.hashToken(req.token);
  const client = services.auth.getClient(tokenHash);

  if (!client) {
    return envelopeError(err('UNAUTHORIZED', 'Invalid or expired token'), req);
  }
  if (client.revoked) {
    return envelopeError(err('CLIENT_REVOKED', 'This client has been revoked'), req);
  }

  // ── 2. Connection lookup ──────────────────────────────────────────────
  const connection = services.connections.get(req.connection_id);
  if (!connection) {
    return envelopeError(err('CONNECTION_NOT_FOUND', `Connection ${req.connection_id} not found`), req);
  }

  // ── 3. Capability lookup ──────────────────────────────────────────────
  const capability = services.capabilities.get(connection.connector_id, req.capability_id);
  if (!capability) {
    return envelopeError(err('CAPABILITY_NOT_FOUND', `Capability ${req.capability_id} not found`), req);
  }

  // ── 4. Authorization (grant check) ───────────────────────────────────
  const grants = services.auth.getGrants(client.id);
  const grant = grants.find(g => g.connection_id === req.connection_id);
  if (!grant) {
    return envelopeError(err('FORBIDDEN', `No grant for connection ${req.connection_id}`), req);
  }
  const allowedCaps = grant.capabilities;
  const hasWildcard = allowedCaps.includes('*');
  if (!hasWildcard && !allowedCaps.includes(req.capability_id)) {
    return envelopeError(err('FORBIDDEN', `Not authorized to call ${req.capability_id}`), req);
  }

  // ── 5. Support status check ───────────────────────────────────────────
  const state = connection.capability_states[req.capability_id] ?? capability.support;
  const blockingStatuses: SupportStatus[] = ['needs_auth', 'needs_plan', 'unsupported', 'disabled'];
  if (blockingStatuses.includes(state.status)) {
    const codeMap: Record<string, ErrorCode> = {
      needs_auth: 'NEEDS_AUTH',
      needs_plan: 'NEEDS_PLAN',
      unsupported: 'NOT_SUPPORTED',
      disabled: capability.kind === 'action' ? 'ACTION_DISABLED' : 'NOT_SUPPORTED',
    };
    return envelopeError(
      err(codeMap[state.status] ?? 'NOT_SUPPORTED', state.reason ?? `Capability status: ${state.status}`),
      req,
    );
  }

  // ── 6. Action safeguard (D9 — all actions disabled this release) ──────
  if (capability.kind === 'action') {
    return envelopeError(
      err('ACTION_DISABLED', 'Write operations are not enabled in this release'),
      req,
    );
  }

  // ── 7. Cache lookup ───────────────────────────────────────────────────
  const source = {
    connection_id: connection.id,
    connection_label: connection.label,
    capability_id: capability.id,
    support: state,
  };

  if (!req.no_cache && capability.cache) {
    const key = cacheKey(req.connection_id, req.capability_id, req.input);
    const cached = services.cache.get(key);
    if (cached && new Date(cached.expires_at) > new Date()) {
      const envelope: ResultEnvelope = {
        ...cached.envelope,
        queried_at: new Date().toISOString(),
        cache: {
          hit: true,
          cached_at: cached.cached_at,
          expires_at: cached.expires_at,
          ttl: cached.ttl,
        },
      };
      services.audit.append({
        client_id: client.id,
        action: `${req.capability_id}:cache_hit`,
        target: req.connection_id,
        detail: { input: req.input },
      });
      return envelope;
    }
  }

  // ── 8. Dispatch ───────────────────────────────────────────────────────
  let envelope: ResultEnvelope;
  try {
    envelope = await services.dispatch.dispatch(connection, capability, req.input);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    envelope = fail(err('INTERNAL_ERROR', `Dispatch failed: ${msg}`), source);
  }

  // ── 9. Redact output ──────────────────────────────────────────────────
  if (envelope.data !== null) {
    envelope = {
      ...envelope,
      data: opts.redactOutput(envelope.data, capability, client.kind),
    };
  }

  // ── 10. Cache store ───────────────────────────────────────────────────
  if (envelope.outcome !== 'error' && capability.cache && !req.no_cache) {
    const key = cacheKey(req.connection_id, req.capability_id, req.input);
    services.cache.set(key, envelope, capability.cache.ttl);
  }

  // ── 11. Audit ─────────────────────────────────────────────────────────
  services.audit.append({
    client_id: client.id,
    action: `${req.capability_id}:${envelope.outcome}`,
    target: req.connection_id,
    detail: { input: req.input, outcome: envelope.outcome },
  });

  return envelope;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function envelopeError(
  error: ApiError,
  req: Pick<InvokeRequest, 'connection_id' | 'capability_id'>,
): ResultEnvelope {
  return fail(error, {
    connection_id: req.connection_id,
    connection_label: req.connection_id,
    capability_id: req.capability_id,
    support: { status: 'supported' },
  });
}
