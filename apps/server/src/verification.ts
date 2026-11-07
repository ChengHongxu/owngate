import { err, fail, validateCapabilityInput, type Capability, type Connection, type InvocationResultContext, type InvokeRequest, type ResultEnvelope, type SupportState, type VerificationPlan } from '@owngate/core';
import { defaultInput } from '@owngate/connector-runtime';
import type { DbClient } from '@owngate/db';

export interface VerificationResult {
  verified: boolean;
  capability_states: Record<string, SupportState>;
  results: Record<string, ResultEnvelope>;
}
interface VerificationDeps {
  db: Pick<DbClient, 'rawRun'>;
  getConnection: (id: string) => Connection | undefined;
  getCapability: (connectionId: string, capabilityId: string) => Capability | undefined;
  listCapabilities: (connectionId: string) => Capability[];
  getPlan: (connectionId: string) => { verification?: VerificationPlan; whoami?: string; browser: boolean };
  invoke: (request: InvokeRequest, userId: string, verify?: boolean) => Promise<ResultEnvelope>;
  notifyChanged?: () => Promise<void>;
}

const AUTH_ERRORS = new Set(['AUTH_REJECTED', 'AUTH_MISSING', 'AUTH_EXPIRED', 'LOGIN_REQUIRED', 'CAPTCHA_PRESENT']);
// These failures concern a caller, a cancelled request or a changed connection,
// rather than evidence that the site's capability stopped working.
const REQUEST_ERRORS = new Set(['INVALID_PARAMS', 'PERMISSION_DENIED', 'UNAUTHENTICATED', 'CLIENT_REVOKED', 'GRANT_REVOKED', 'CONNECTION_NOT_FOUND', 'CAPABILITY_NOT_FOUND', 'CAPABILITY_DISABLED']);

/** Verification and normal queries share one guarded observation path. */
export class ConnectionVerifier {
  private readonly observations = new Map<string, Promise<void>>();
  private readonly latestSequences = new WeakMap<Connection, Map<string, number>>();
  private readonly latestAuthSequences = new WeakMap<Connection, number>();
  constructor(private readonly deps: VerificationDeps) {}

  async run(connectionId: string, capabilityId: string, input: unknown, userId: string): Promise<ResultEnvelope> {
    const connection = this.deps.getConnection(connectionId);
    const capability = this.deps.getCapability(connectionId, capabilityId);
    const source = { connection_id: connectionId, connection_label: connection?.label ?? connectionId, capability_id: capabilityId,
      support: connection?.capability_states[capabilityId] ?? capability?.support ?? { status: 'unsupported' as const } };
    if (!connection) return fail(err('CONNECTION_NOT_FOUND', 'Connection not found'), source);
    if (!capability) return fail(err('PERMISSION_DENIED', 'Capability is unavailable for this connection'), source);
    if (connection.paused || capability.kind !== 'query' || capability.effect !== 'read' || ['disabled', 'unsupported'].includes(source.support.status)) {
      return fail(err('CAPABILITY_DISABLED', 'This read-only capability is currently unavailable'), source);
    }
    const values = defaultInput(input, capability.input);
    const invalid = validateCapabilityInput(capability, values);
    if (invalid) return fail(invalid, source);
    return this.deps.invoke({ connection_id: connectionId, capability_id: capabilityId, input: values, no_cache: true }, userId, true);
  }

  observe(result: ResultEnvelope, context: InvocationResultContext): Promise<SupportState | undefined> {
    return this.enqueue(context.connection.id, () => this.record(result, context));
  }

  private enqueue<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.observations.get(id) ?? Promise.resolve();
    const operation = previous.then(run);
    const tail = operation.then(() => undefined, () => undefined);
    this.observations.set(id, tail);
    void tail.then(() => { if (this.observations.get(id) === tail) this.observations.delete(id); });
    return operation;
  }

  /** A real whoami probe shares the invocation clock, including delayed calls. */
  noteProbe(connectionId: string, capabilityId: string, sequence: number, updatedIds: string[]): void {
    const connection = this.deps.getConnection(connectionId);
    if (!connection) return;
    const sequences = this.latestSequences.get(connection) ?? new Map<string, number>();
    for (const id of new Set([capabilityId, ...updatedIds])) sequences.set(id, Math.max(sequence, sequences.get(id) ?? 0));
    this.latestSequences.set(connection, sequences);
    const plan = this.deps.getPlan(connectionId);
    if ((plan.verification?.auth ?? plan.whoami) === capabilityId) this.latestAuthSequences.set(connection, Math.max(sequence, this.latestAuthSequences.get(connection) ?? 0));
  }

  private async record(result: ResultEnvelope, context: InvocationResultContext, retries = 0): Promise<SupportState | undefined> {
    const { connection, capability, revision, verification, sequence } = context;
    const current = this.deps.getConnection(connection.id);
    // New credentials, settings, a newer observation or deletion always win
    // over a network response that began with an older connection revision.
    if (!current || current !== connection || current.updated_at !== revision || current.paused) return undefined;
    const previousStates = current.capability_states;
    const existing = current.capability_states[capability.id] ?? capability.support;
    if (['disabled', 'unsupported'].includes(existing.status)) return undefined;
    const sequences = this.latestSequences.get(current) ?? new Map<string, number>();
    // Result persistence/audit may complete out of dispatch order. A trusted
    // local execution sequence prevents late old results undoing newer facts.
    if (sequence <= (sequences.get(capability.id) ?? 0)) return existing;
    const code = result.error?.code;
    if (result.outcome === 'error' && code && REQUEST_ERRORS.has(code)) return undefined;
    if (code && AUTH_ERRORS.has(code) && sequence < (this.latestAuthSequences.get(current) ?? 0)) return existing;
    const status = result.outcome === 'success' ? 'supported' : result.outcome === 'partial' ? 'partial'
      : code && AUTH_ERRORS.has(code) ? 'needs_auth'
      : code === 'PLAN_INSUFFICIENT' ? 'needs_plan'
      : code === 'CAPABILITY_UNSUPPORTED' || code === 'PARSE_FAILED' ? 'needs_adapter' : 'unavailable';
    const now = new Date(Math.max(Date.now(), (Date.parse(revision) || 0) + 1)).toISOString();
    const state: SupportState = { status, probed_at: now, ...(result.error ? { reason: result.error.message } : {}) };
    const states = { ...current.capability_states, [capability.id]: state };
    const touched = new Set([capability.id]);
    const plan = this.deps.getPlan(connection.id);
    const auth = plan.verification?.auth ?? plan.whoami;
    if (auth === capability.id && sequence <= (this.latestAuthSequences.get(current) ?? 0)) return existing;
    if (auth === capability.id) {
      for (const candidate of this.deps.listCapabilities(connection.id)) {
        const prior = states[candidate.id] ?? candidate.support;
        if (candidate.kind !== 'query' || candidate.effect !== 'read' || candidate.id === capability.id || ['disabled', 'unsupported'].includes(prior.status)) continue;
        if ((sequences.get(candidate.id) ?? 0) > sequence) continue;
        if (result.outcome !== 'error' && (prior.status === 'needs_auth' || prior.status === 'needs_adapter' && !prior.probed_at)) {
          states[candidate.id] = { status: 'unverified' };
          touched.add(candidate.id);
        } else if (status === 'needs_auth') {
          states[candidate.id] = { ...state };
          touched.add(candidate.id);
        }
      }
    }
    // Repeated normal queries with the same outcome must not invalidate every
    // cache entry for this connection. Explicit verification refreshes its time.
    const same = (a: SupportState, b: SupportState) => a.status === b.status && a.reason === b.reason;
    const changed = Object.entries(states).some(([id, value]) => !same(value, current.capability_states[id] ?? this.deps.getCapability(connection.id, id)?.support ?? { status: 'unverified' }));
    const accepted = !verification && !changed && existing.probed_at ? existing
      : await this.persist(current, revision, states, now, false, capability.id);
    // A whoami probe may win the same state CAS while this observation waits
    // on SQLite. Merge a newer query against that accepted state once more.
    if (!accepted && retries < 2 && this.deps.getConnection(connection.id) === current && current.updated_at === revision && current.capability_states !== previousStates) {
      return this.record(result, context, retries + 1);
    }
    if (accepted) {
      const latest = this.latestSequences.get(current) ?? sequences;
      for (const id of touched) latest.set(id, Math.max(sequence, latest.get(id) ?? 0));
      this.latestSequences.set(current, latest);
      if (auth === capability.id) this.latestAuthSequences.set(current, Math.max(sequence, this.latestAuthSequences.get(current) ?? 0));
    }
    return accepted ? current.capability_states[capability.id] ?? accepted : undefined;
  }

  /** A cookie/login signal invalidates old observations; it does not prove auth. */
  loginCompleted(connectionId: string, since?: string): Promise<void> {
    return this.enqueue(connectionId, () => this.resetAfterLogin(connectionId, since));
  }

  private async resetAfterLogin(connectionId: string, since?: string): Promise<void> {
    const current = this.deps.getConnection(connectionId);
    if (!current || current.paused) return;
    // A worker's settled login result can outlive a server restart. Do not
    // erase newer verified data when that old status is polled again.
    const latest = Math.max(Date.parse(current.updated_at) || 0, ...Object.values(current.capability_states).map(state => Date.parse(state.probed_at ?? '') || 0));
    if (since && (!Number.isFinite(Date.parse(since)) || Date.parse(since) <= latest)) return;
    const revision = current.updated_at;
    const states = { ...current.capability_states };
    for (const capability of this.deps.listCapabilities(connectionId)) {
      const prior = states[capability.id] ?? capability.support;
      if (capability.kind === 'query' && capability.effect === 'read' && !['disabled', 'unsupported'].includes(prior.status)) states[capability.id] = { status: 'unverified' };
    }
    const now = new Date(Math.max(Date.now(), (Date.parse(revision) || 0) + 1)).toISOString();
    await this.persist(current, revision, states, now, true);
  }

  private async persist(current: Connection, revision: string, states: Record<string, SupportState>, now: string, advanceRevision: boolean, capabilityId?: string): Promise<SupportState | undefined> {
    const before = current.capability_states;
    const query = advanceRevision ? 'UPDATE connections SET capability_states=?,updated_at=? WHERE id=? AND updated_at=? AND capability_states=?'
      : 'UPDATE connections SET capability_states=? WHERE id=? AND updated_at=? AND capability_states=?';
    const values = [JSON.stringify(states), ...(advanceRevision ? [now] : []), current.id, revision, JSON.stringify(before)];
    const saved = await this.deps.db.rawRun(query, values);
    if (!saved.changes || this.deps.getConnection(current.id) !== current || current.updated_at !== revision || current.capability_states !== before) return undefined;
    current.capability_states = states;
    if (advanceRevision) current.updated_at = now;
    await this.deps.notifyChanged?.();
    return capabilityId ? states[capabilityId] : undefined;
  }

  async verify(connectionId: string, userId: string, selected?: { capability_id: string; input?: unknown }): Promise<VerificationResult> {
    const plan = this.deps.getPlan(connectionId);
    const candidates = selected ? [selected.capability_id] : plan.verification ? plan.verification.capabilities
      : plan.browser ? (plan.whoami ? [plan.whoami] : []) : this.deps.listCapabilities(connectionId).filter(cap => cap.kind === 'query' && cap.effect === 'read' && !validateCapabilityInput(cap, defaultInput({}, cap.input))).map(cap => cap.id);
    const results: Record<string, ResultEnvelope> = {};
    for (const id of candidates) {
      const connection = this.deps.getConnection(connectionId);
      const capability = this.deps.getCapability(connectionId, id);
      if (!capability || capability.kind !== 'query' || capability.effect !== 'read') continue;
      const support = connection?.capability_states[id] ?? capability.support;
      if (['disabled', 'unsupported'].includes(support.status)) continue;
      results[id] = await this.run(connectionId, id, selected?.input ?? {}, userId);
    }
    return { verified: Object.keys(results).length > 0 && Object.values(results).every(result => result.outcome !== 'error'),
      capability_states: this.deps.getConnection(connectionId)?.capability_states ?? {}, results };
  }
}
