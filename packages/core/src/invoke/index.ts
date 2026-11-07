// The common execution gate for token clients and authenticated admin sessions.
import { Ajv, type ValidateFunction } from 'ajv';
import { createHash } from 'node:crypto';
import type { Capability, Connection, Client, Grant, JSONSchema, SupportState, SupportStatus } from '../types/index.js';
import { err, ERROR_TEXT } from '../errors/index.js';
import { fail } from '../envelope/index.js';
import type { ResultEnvelope, ExecutionStep } from '../envelope/index.js';
import type { ApiError, ErrorCode } from '../errors/index.js';

type MaybePromise<T> = T | Promise<T>;

export interface CapabilityRegistry {
  get(connectorId: string, capabilityId: string): Capability | undefined;
  version?(connectorId: string): string | undefined;
  list?(connectorId: string): Capability[];
}
export interface ConnectionStore { get(connectionId: string): Connection | undefined }
export interface AuthStore {
  getClient(tokenHash: string): Client | undefined;
  /** Trusted server jobs look up the current client without storing its token. */
  getClientById?(clientId: string): Client | undefined;
  getGrants(clientId: string): Grant[];
}
export interface CacheStore {
  get(key: string): MaybePromise<CachedResult | undefined>;
  set(key: string, envelope: ResultEnvelope, ttl: number): MaybePromise<void>;
  invalidate(clientId: string): MaybePromise<void>;
}
export interface CachedResult {
  envelope: ResultEnvelope;
  cached_at: string;
  expires_at: string;
  ttl: number;
}
export interface AuditStore { append(entry: AuditEntry): MaybePromise<void> }
export interface AuditEntry {
  client_id: string | undefined;
  action: string;
  target: string | undefined;
  detail: unknown;
}
export interface Dispatcher {
  dispatch(connection: Connection, capability: Capability, input: unknown): Promise<ResultEnvelope>;
}
export interface InvokeServices {
  capabilities: CapabilityRegistry;
  connections: ConnectionStore;
  auth: AuthStore;
  cache: CacheStore;
  audit: AuditStore;
  dispatch: Dispatcher;
}
export interface InvokeRequest {
  token?: string;
  connection_id: string;
  capability_id: string;
  input: unknown;
  no_cache?: boolean;
}

/** Only server code may provide this argument, after authenticating a session. */
export interface AdminCaller {
  kind: 'admin';
  user_id: string;
  /** A read-only probe may run before authentication/adapter state is known. */
  verify?: true;
}
/** Server-owned identity for durable jobs; never read this from request JSON. */
export interface TrustedClientCaller {
  kind: 'client';
  client_id: string;
}
export type InvokeCaller = AdminCaller | TrustedClientCaller;
/** A server-owned observer; never accepted from request JSON. */
export type ExecutionEvent =
  | { type: 'start'; id: string; label: string }
  | ({ type: 'finish' } & ExecutionStep);
/** The server observes only a fresh, validated invocation under its starting revision. */
export interface InvocationResultContext {
  connection: Connection;
  capability: Capability;
  revision: string;
  verification: boolean;
  /** Local dispatch order, shared by callers of one deduplicated execution. */
  sequence: number;
}
export interface InvokeOptions {
  hashToken: (token: string) => string;
  redactOutput: (data: unknown, capability: Capability, audience: 'admin' | 'client', client?: Client, grant?: Grant) => unknown;
  /** Removes registered secret values and token patterns from errors and audit. */
  sanitize?: (value: unknown) => unknown;
  /** Local cancellation only. This never asserts that an upstream job stopped. */
  signal?: AbortSignal;
  /** Server-only synchronous sink for an encrypted durable result. Never expose it directly. */
  onAuthorizedResult?: (raw: ResultEnvelope) => void;
  /** Best-effort administrator diagnostics. Exceptions in this sink are ignored. */
  onExecutionEvent?: (event: ExecutionEvent) => void;
  /** Best-effort state observation after validation and filtering, never for cache hits or rejected calls. */
  onInvocationResult?: (result: ResultEnvelope, context: InvocationResultContext) => MaybePromise<SupportState | undefined>;
}

const validator = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const compiledSchemas = new WeakMap<JSONSchema, ValidateFunction>();

function validate(schema: JSONSchema, value: unknown): string | undefined {
  let check = compiledSchemas.get(schema);
  if (!check) {
    check = validator.compile(schema);
    compiledSchemas.set(schema, check);
  }
  if (check(value)) return undefined;
  // Do not include offending values: parameters or upstream data may be secret.
  return check.errors?.map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`).join('; ') ?? 'Invalid data';
}

/** Shared input validation for durable submission and immediate invocation. */
export function validateCapabilityInput(capability: Capability, input: unknown): ApiError | undefined {
  const message = validate(capability.input, input);
  return message ? err('INVALID_PARAMS', `Input does not match schema: ${message}`) : undefined;
}

export function isCapabilityRoleAllowed(connection: Connection, capability: Capability): boolean {
  return capability.roles === undefined || capability.roles.includes(connection.config['role'] === 'admin' ? 'admin' : 'user');
}

/** Invalid expiration timestamps also fail closed. */
export function isClientExpired(client: Client): boolean {
  if (!client.expires_at) return false;
  const expiry = Date.parse(client.expires_at);
  return !Number.isFinite(expiry) || expiry <= Date.now();
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, normalized(v)]));
}

export interface AuditInputSummary {
  sha256: string;
  bytes: number;
  type: string;
  fields: string[];
  field_count: number;
  additional_field_count: number;
}

/** Audit correlates requests without persisting parameters or user-chosen keys. */
export function summarizeAuditInput(input: unknown, schema: JSONSchema): AuditInputSummary {
  const canonical = JSON.stringify(normalized(input)) ?? 'undefined';
  const object = typeof input === 'object' && input !== null && !Array.isArray(input);
  const keys = object ? Object.keys(input) : [];
  const properties = schema['properties'];
  const declared = typeof properties === 'object' && properties !== null && !Array.isArray(properties) ? properties : {};
  // Only schema-declared names are safe to record. additionalProperties may
  // themselves be email addresses, document contents, or other private values.
  const fields = keys.filter((key) => Object.hasOwn(declared, key)).sort();
  return { sha256: createHash('sha256').update(canonical).digest('hex'), bytes: Buffer.byteLength(canonical),
    type: input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input,
    fields, field_count: keys.length, additional_field_count: keys.length - fields.length };
}

function cacheKey(connectionId: string, capabilityId: string, input: unknown, version?: string, revision?: string): string {
  const payload = JSON.stringify({ c: connectionId, v: version, r: revision, a: capabilityId, i: normalized(input) });
  return `${connectionId}:${capabilityId}:${createHash('sha256').update(payload).digest('hex')}`;
}

type DispatchResult = { envelope: ResultEnvelope; executed: true; sequence: number }
  | { envelope: ResultEnvelope; executed: false };
interface SchedulingState {
  pending: Map<string, Promise<DispatchResult>>;
  queues: Map<string, Promise<void>>;
  sequence: number;
}
// Service instances isolate independent servers and tests from each other.
const schedules = new WeakMap<InvokeServices, SchedulingState>();

function schedulingState(services: InvokeServices): SchedulingState {
  let state = schedules.get(services);
  if (!state) {
    state = { pending: new Map(), queues: new Map(), sequence: 0 };
    schedules.set(services, state);
  }
  return state;
}

/** Reserve trusted local ordering for probes that share invocation state. */
export function reserveInvocationSequence(services: InvokeServices): number {
  return ++schedulingState(services).sequence;
}

function dispatchOnce(
  services: InvokeServices,
  connection: Connection,
  capability: Capability,
  input: unknown,
  key: string,
  guard: () => ApiError | undefined,
): Promise<DispatchResult> {
  const state = schedulingState(services);
  const existing = state.pending.get(key);
  if (existing) return existing;
  const before = state.queues.get(connection.id) ?? Promise.resolve();
  const execution = before.then(async (): Promise<DispatchResult> => {
    const denied = guard();
    const source = {
      connection_id: connection.id, connection_label: connection.label, capability_id: capability.id,
      support: connection.capability_states[capability.id] ?? capability.support,
    };
    if (denied) return { envelope: fail(denied, source), executed: false };
    const sequence = reserveInvocationSequence(services);
    try {
      return { envelope: await services.dispatch.dispatch(connection, capability, input), executed: true, sequence };
    } catch {
      return { envelope: fail(err('INTERNAL_ERROR', 'Capability execution failed'), source), executed: true, sequence };
    }
  });
  const tail = execution.then(() => {}, () => {});
  state.pending.set(key, execution);
  state.queues.set(connection.id, tail);
  const clearFlight = () => { if (state.pending.get(key) === execution) state.pending.delete(key); };
  void execution.then(clearFlight, clearFlight);
  void tail.then(() => { if (state.queues.get(connection.id) === tail) state.queues.delete(connection.id); });
  return execution;
}

function redactedPaths(before: unknown, after: unknown, path = ''): string[] {
  if (before === null || before === undefined) return [];
  if (after === null || after === undefined) return path ? [path] : [];
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.flatMap((value, i) => redactedPaths(value, after[i], `${path}[${i}]`));
  }
  if (typeof before === 'object' && typeof after === 'object') {
    return Object.entries(before).flatMap(([key, value]) => redactedPaths(value, (after as Record<string, unknown>)[key], path ? `${path}.${key}` : key));
  }
  return [];
}

/** Reapply the current field policy to a cached or durable authorized result. */
export function filterResultEnvelope(
  raw: ResultEnvelope,
  capability: Capability,
  audience: 'admin' | 'client',
  opts: InvokeOptions,
  client?: Client,
  grant?: Grant,
): ResultEnvelope {
  const data = raw.data === null ? null : opts.redactOutput(structuredClone(raw.data), capability, audience, client, grant);
  const fields = { ...raw.fields };
  for (const path of redactedPaths(raw.data, data)) {
    fields[path] = { ...fields[path], status: 'redacted', reason: '当前客户端不可见或字段包含秘密' };
  }
  // Diagnostics belong to the current administrator request, not cached or
  // durable business results. Never forward a trace from an older result.
  const { execution: _execution, ...businessResult } = raw;
  const result = { ...businessResult, data, fields };
  return (opts.sanitize?.(result) ?? result) as ResultEnvelope;
}

/** Returns a result envelope for every expected authentication/execution failure. */
export async function invoke(
  req: InvokeRequest,
  services: InvokeServices,
  opts: InvokeOptions,
  caller?: InvokeCaller,
): Promise<ResultEnvelope> {
  let client: Client | undefined;
  let connection: Connection | undefined;
  let capability: Capability | undefined;
  const admin = caller?.kind === 'admin' && caller.user_id.length > 0;
  let phase: { id: string; label: string; started: number } | undefined;
  const emit = (event: ExecutionEvent) => {
    if (!admin) return;
    try { opts.onExecutionEvent?.(event); } catch { /* Diagnostics cannot alter an invocation. */ }
  };
  const finish = (status: ExecutionStep['status'] = 'success', detail?: string, code?: string) => {
    if (!phase) return;
    const current = phase; phase = undefined;
    emit({ type: 'finish', id: current.id, label: current.label, status,
      duration_ms: Math.max(0, performance.now() - current.started),
      ...(detail ? { detail } : {}), ...(code ? { code } : {}) });
  };
  const begin = (id: string, label: string) => {
    finish(); phase = { id, label, started: performance.now() };
    emit({ type: 'start', id, label });
  };
  const currentClient = () => caller?.kind === 'client'
    ? services.auth.getClientById?.(caller.client_id)
    : req.token ? services.auth.getClient(opts.hashToken(req.token)) : undefined;
  const sanitize = <T>(value: T): T => (opts.sanitize ? opts.sanitize(value) : value) as T;
  const audit = async (action: string, detail: unknown): Promise<void> => {
    await services.audit.append({
      client_id: admin ? undefined : client?.id,
      action,
      target: req.connection_id,
      detail: sanitize({ ...((typeof detail === 'object' && detail !== null) ? detail : { detail }), ...(admin && caller?.kind === 'admin' ? { actor: { kind: 'admin', user_id: caller.user_id } } : {}) }),
    });
  };
  const denied = async (error: ApiError): Promise<ResultEnvelope> => {
    // Business messages may quote a private account path, schema property or
    // upstream exception. Observations use only the canonical fixed text.
    finish('error', ERROR_TEXT[error.code]?.what_happened ?? '请求未通过检查', error.code);
    const envelope = fail(error, {
      connection_id: req.connection_id,
      connection_label: connection?.label ?? req.connection_id,
      capability_id: req.capability_id,
      support: connection?.capability_states[req.capability_id] ?? capability?.support ?? { status: 'unsupported' },
    });
    begin('request.denied', '记录拒绝结果并返回');
    await audit(`${req.capability_id}:denied`, { code: error.code });
    const result = sanitize(envelope);
    finish();
    return result;
  };
  const authorizationError = (): ApiError | undefined => {
    if (admin) return undefined;
    client = currentClient();
    if (!client) return err('UNAUTHENTICATED', 'Invalid or expired token');
    if (client.revoked) return err('CLIENT_REVOKED', 'This client has been revoked');
    if (isClientExpired(client)) return err('UNAUTHENTICATED', 'Invalid or expired token');
    const grant = services.auth.getGrants(client.id).find((g) => g.connection_id === req.connection_id);
    if (!grant || (!grant.capabilities.includes(req.capability_id) && !(grant.capabilities.includes('*') && capability?.kind !== 'action'))) {
      return err('PERMISSION_DENIED', 'Not authorized to call this capability');
    }
    return undefined;
  };
  const filter = (raw: ResultEnvelope): ResultEnvelope => {
    const { execution: _execution, ...businessResult } = raw;
    opts.onAuthorizedResult?.(sanitize(structuredClone(businessResult)));
    const grant = client ? services.auth.getGrants(client.id).find((g) => g.connection_id === req.connection_id) : undefined;
    return filterResultEnvelope(businessResult, capability!, admin ? 'admin' : 'client', opts, client, grant);
  };
  const contextError = (revision: string): ApiError | undefined => {
    const authError = authorizationError();
    if (authError) return authError;
    const latest = services.connections.get(req.connection_id);
    if (!latest) return err('CONNECTION_NOT_FOUND', 'Connection was removed during execution');
    const currentCapability = services.capabilities.get(latest.connector_id, req.capability_id);
    if (!currentCapability || !isCapabilityRoleAllowed(latest, currentCapability)) return err('PERMISSION_DENIED', 'Capability is not available for the current connection role');
    if (latest.paused) return err('CAPABILITY_DISABLED', 'Connection is paused');
    if (opts.signal?.aborted) return err('CAPABILITY_DISABLED', 'Execution was cancelled locally; the upstream may still be running');
    if (latest.updated_at !== revision) return err('GRANT_REVOKED', 'Connection settings changed during execution; retry with the current settings');
    return undefined;
  };

  begin('request.validate', '检查连接与权限');
  try {
    // Authenticate before looking up resources, to avoid resource discovery.
    if (!admin) {
      client = currentClient();
      if (!client) return await denied(err('UNAUTHENTICATED', 'Invalid or expired token'));
      if (client.revoked) return await denied(err('CLIENT_REVOKED', 'This client has been revoked'));
      if (isClientExpired(client)) return await denied(err('UNAUTHENTICATED', 'Invalid or expired token'));
    }
    connection = services.connections.get(req.connection_id);
    if (!connection) return await denied(err('CONNECTION_NOT_FOUND', 'Connection not found'));
    capability = services.capabilities.get(connection.connector_id, req.capability_id);
    if (!capability) return await denied(err('CAPABILITY_NOT_FOUND', 'Capability not found'));
    const authError = authorizationError();
    if (authError) return await denied(authError);
    if (!isCapabilityRoleAllowed(connection, capability)) return await denied(err('PERMISSION_DENIED', 'Capability is not available for the current connection role'));
    if (connection.paused) return await denied(err('CAPABILITY_DISABLED', 'Connection is paused'));
    if (opts.signal?.aborted) return await denied(err('CAPABILITY_DISABLED', 'Execution was cancelled locally'));

    // This is unconditional, including verification by an admin session.
    if (capability.kind === 'action' || capability.effect !== 'read') {
      return await denied(err('CAPABILITY_DISABLED', 'Write operations are not enabled in this release'));
    }
    const override = connection.capability_states[req.capability_id];
    const state = override ?? capability.support;
    const codeMap: Partial<Record<SupportStatus, ErrorCode>> = {
      needs_auth: override === undefined ? 'AUTH_MISSING' : 'AUTH_EXPIRED',
      needs_plan: 'PLAN_INSUFFICIENT', needs_adapter: 'CAPABILITY_UNSUPPORTED',
      unsupported: 'CAPABILITY_UNSUPPORTED', disabled: 'CAPABILITY_DISABLED',
    };
    const verification = admin && caller?.kind === 'admin' && caller.verify === true;
    const skipState = verification && (state.status === 'needs_auth' || state.status === 'needs_adapter' || state.status === 'needs_plan');
    if (codeMap[state.status] && !skipState) {
      return await denied(err(codeMap[state.status]!, state.reason ?? `Capability status: ${state.status}`));
    }
    begin('request.input', '校验查询参数');
    const inputError = validateCapabilityInput(capability, req.input);
    if (inputError) return await denied(inputError);
    const inputSummary = summarizeAuditInput(req.input, capability.input);
    finish();

    const useCache = !req.no_cache && !verification && capability.cache !== null;
    const revision = connection.updated_at;
    const key = cacheKey(req.connection_id, req.capability_id, req.input, services.capabilities.version?.(connection.connector_id), revision);
    if (useCache) {
      begin('request.cache', '检查查询缓存');
      const cached = await services.cache.get(key);
      if (cached && new Date(cached.expires_at) > new Date()) {
        finish('success', '使用尚未过期的缓存，未执行站点查询');
        begin('request.result', '检查当前权限并返回结果');
        const currentAuthError = authorizationError();
        if (currentAuthError) return await denied(currentAuthError);
        await audit(`${req.capability_id}:cache_hit`, { input_summary: inputSummary });
        const changed = contextError(revision);
        if (changed) return await denied(changed);
        const currentConnection = services.connections.get(req.connection_id)!;
        const currentCapability = services.capabilities.get(currentConnection.connector_id, req.capability_id)!;
        const result = filter({ ...cached.envelope, source: { ...cached.envelope.source,
          support: structuredClone(currentConnection.capability_states[req.capability_id] ?? currentCapability.support),
        }, queried_at: new Date().toISOString(), cache: {
          hit: true, cached_at: cached.cached_at, expires_at: cached.expires_at, ttl: cached.ttl,
        } });
        finish();
        return result;
      }
      finish('success', '没有可用缓存，继续执行查询');
    }

    let envelope: ResultEnvelope;
    let sequence: number | undefined;
    begin('request.execute', '排队并执行查询');
    try {
      const dispatched = await dispatchOnce(services, connection, capability, req.input, `${verification ? 'verify:' : ''}${key}`, () => contextError(revision));
      const { execution: _execution, ...businessResult } = dispatched.envelope;
      envelope = businessResult;
      if (dispatched.executed) sequence = dispatched.sequence;
    } catch {
      envelope = fail(err('INTERNAL_ERROR', 'Capability execution failed'), {
        connection_id: connection.id, connection_label: connection.label, capability_id: capability.id, support: state,
      });
    }
    finish(envelope.outcome === 'error' ? 'error' : envelope.outcome === 'partial' ? 'partial' : 'success',
      envelope.error ? ERROR_TEXT[envelope.error.code]?.what_happened ?? '查询执行失败' : undefined, envelope.error?.code);
    if (envelope.data !== null && envelope.outcome !== 'error') {
      begin('request.output', '检查返回数据结构');
      const outputError = validate(capability.output, envelope.data);
      if (outputError) {
        envelope = fail(err('PARSE_FAILED', `Output does not match schema: ${outputError}`), envelope.source);
        finish('error', '返回数据未通过结构校验', envelope.error!.code);
      } else {
        finish();
      }
    }
    begin('request.result', '检查当前权限并返回结果');
    const currentAuthError = authorizationError();
    if (currentAuthError) return await denied(currentAuthError);
    const latestConnection = services.connections.get(req.connection_id);
    if (!latestConnection) return await denied(err('CONNECTION_NOT_FOUND', 'Connection was removed during execution'));
    if (envelope.outcome !== 'error' && latestConnection.updated_at !== revision) {
      return await denied(err('GRANT_REVOKED', 'Connection settings changed during execution; retry with the current settings'));
    }
    if (useCache && envelope.outcome !== 'error') {
      // Store the unfiltered result; every reader applies its current policy.
      await services.cache.set(key, structuredClone(envelope), capability.cache!.ttl);
    }
    await audit(`${req.capability_id}:${envelope.outcome}`, { input_summary: inputSummary, outcome: envelope.outcome });
    // Storage and audit are asynchronous too: revocation must still win when
    // it happens during those writes, immediately before returning data.
    const finalAuthError = authorizationError();
    if (finalAuthError) return await denied(finalAuthError);
    if (envelope.outcome !== 'error') {
      const changed = contextError(revision);
      if (changed) return await denied(changed);
    }
    let result = filter(envelope);
    if (sequence !== undefined && opts.onInvocationResult) {
      try {
        const support = await opts.onInvocationResult(structuredClone(result), { connection, capability, revision, verification, sequence });
        if (support) result.source = { ...result.source, support: sanitize(structuredClone(support)) };
      } catch { /* State observation cannot change an already authorized business result. */ }
      // Observation writes only runtime state. A credential/configuration or
      // authorization change during its asynchronous write must still win.
      const observedAuthError = authorizationError();
      if (observedAuthError) return await denied(observedAuthError);
      if (result.outcome !== 'error') {
        const changed = contextError(revision);
        if (changed) return await denied(changed);
      }
      // Field visibility may change without revoking the capability grant.
      // Re-filter the original data under the current policy after the await,
      // without delivering it to the private durable-result sink a second time.
      const grant = client ? services.auth.getGrants(client.id).find(value => value.connection_id === req.connection_id) : undefined;
      result = filterResultEnvelope({ ...envelope, source: { ...envelope.source, support: result.source.support } },
        capability, admin ? 'admin' : 'client', opts, client, grant);
    }
    finish();
    return result;
  } catch {
    // A malformed connector schema or failing store is an internal failure,
    // never a raw exception/string containing upstream data or credentials.
    finish('error', '查询未能完成，请检查当前连接或稍后重试', 'INTERNAL_ERROR');
    return sanitize(fail(err('INTERNAL_ERROR', 'Capability execution could not be completed'), {
      connection_id: req.connection_id, connection_label: connection?.label ?? req.connection_id,
      capability_id: req.capability_id, support: capability?.support ?? { status: 'unsupported' },
    }));
  }
}
