// Login-state probe scheduler — design §4.4.3 (登录态维护) and §4.5 (隔离与故障处理).
//
// Every intervalMs (default 6 h) each browser-transport connection runs a
// lightweight whoami capability through the browser worker:
//   - needs_auth → every capability of that connection becomes needs_auth, so
//     invoke() refuses with AUTH_EXPIRED instead of returning empty data.
//   - timeout    → state is left alone and the event is audited. One timeout
//     is not evidence that the login expired (§4.5 熔断 counts consecutive
//     failures; that counter lives in the dispatcher, not here).
//   - any other error → same as timeout: keep state, audit.
// Each connection is probed in isolation: one failing connection never stops
// the others from being written back.
//
// Missed runs are not replayed (§10, 错过执行不补跑): the timer only ever runs
// the current period, and start() runs one probe immediately.
//
// Timer: plain setInterval. croner is not a dependency of @owngate/server yet;
// a fixed interval needs no cron expression, so this avoids a new package.

import type { Connection, SupportState, SupportStatus } from '@owngate/core';
import type { DbClient } from '@owngate/db';

export const DEFAULT_PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;
// setInterval clamps delays above 2^31-1 ms to 1 ms; refuse them instead.
const MAX_TIMER_MS = 2_147_483_647;

export const NEEDS_AUTH_REASON = '登录态已失效，需要重新登录';

export interface ProbeTarget {
  /** Capability id of the lightweight whoami query (manifest login.whoami). */
  whoami: string;
  /** All capability ids of this connection; all are marked on needs_auth. */
  capabilities: string[];
}

export interface ProbeAuditEntry {
  action: string;
  target?: string;
  detail?: unknown;
}

export interface ProbeDeps {
  db: Pick<DbClient, 'rawRun'>;
  connectionMap: Map<string, Connection>;
  /**
   * Runs one capability probe on the browser worker (POST /v1/probe).
   * Throws on transport failure; a TimeoutError / AbortError is a timeout.
   */
  probe: (connectionId: string, capabilityId: string) => Promise<{ status: string; reason?: string }>;
  /**
   * Returns the probe target for browser-transport connections, or undefined
   * for anything else (HTTP connections are skipped).
   */
  resolveTarget: (connection: Connection) => ProbeTarget | undefined;
  audit: (entry: ProbeAuditEntry) => void;
  /** Shares the trusted server execution clock with ordinary invocations. */
  nextSequence: () => number;
  onObserved?: (connectionId: string, capabilityId: string, sequence: number, updatedIds: string[]) => void;
  intervalMs?: number;
  /** Injected for tests. */
  now?: () => Date;
}

export type ProbeResultStatus = SupportStatus | 'timeout' | 'error' | 'skipped' | 'not_found';

export interface ProbeResult {
  connectionId: string;
  status: string;
  reason?: string;
}

export interface ProbeStatus {
  lastRunAt: string | null;
  lastResults: ProbeResult[];
}

const SUPPORT_STATUSES: ReadonlySet<string> = new Set<SupportStatus>([
  'unverified', 'supported', 'partial', 'needs_auth', 'needs_plan', 'needs_adapter', 'unavailable', 'unsupported', 'disabled',
]);

function isTimeout(e: unknown): boolean {
  if (e instanceof Error) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
    return /timeout|timed out|abort/i.test(e.message);
  }
  return false;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function withReason(result: ProbeResult, reason: string | undefined): ProbeResult {
  return reason === undefined ? result : { ...result, reason };
}

export class ProbeScheduler {
  private readonly deps: ProbeDeps;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private readonly inflight = new Map<string, Promise<ProbeResult>>();
  private readonly latest = new Map<string, ProbeResult>();
  private lastRunAt: string | null = null;

  constructor(deps: ProbeDeps) {
    const intervalMs = deps.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > MAX_TIMER_MS) {
      throw new RangeError(`probe intervalMs must be in (0, ${MAX_TIMER_MS}], got ${intervalMs}`);
    }
    this.deps = deps;
    this.intervalMs = intervalMs;
  }

  /** Runs one probe now, then every intervalMs. Calling twice is a no-op. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    // Do not keep the process alive just for the probe timer.
    this.timer.unref();
    void this.runOnce();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Probe one connection (by id) or every connection. Never rejects: each
   * connection's failure is captured in its own result.
   */
  async runOnce(connectionId?: string): Promise<ProbeResult[]> {
    const ids = connectionId === undefined
      ? Array.from(this.deps.connectionMap.keys())
      : [connectionId];
    const results = await Promise.all(ids.map((id) => this.probeShared(id)));
    this.lastRunAt = this.nowIso();
    for (const r of results) this.latest.set(r.connectionId, r);
    return results;
  }

  getStatus(): ProbeStatus {
    return { lastRunAt: this.lastRunAt, lastResults: Array.from(this.latest.values()) };
  }

  // A timer tick and an admin "probe now" for the same connection share one
  // browser round-trip instead of racing to write capability_states.
  private probeShared(connectionId: string): Promise<ProbeResult> {
    const existing = this.inflight.get(connectionId);
    if (existing !== undefined) return existing;
    const p = this.probeConnection(connectionId).finally(() => {
      this.inflight.delete(connectionId);
    });
    this.inflight.set(connectionId, p);
    return p;
  }

  private async probeConnection(connectionId: string): Promise<ProbeResult> {
    const connection = this.deps.connectionMap.get(connectionId);
    if (connection === undefined) {
      return { connectionId, status: 'not_found', reason: 'connection not found' };
    }

    if (connection.paused) return { connectionId, status: 'skipped', reason: 'connection is paused' };
    const revision = connection.updated_at;
    const previousStates = connection.capability_states;

    let target: ProbeTarget | undefined;
    try {
      target = this.deps.resolveTarget(connection);
    } catch (e) {
      return this.failure(connectionId, 'error', 'probe.error', e);
    }
    if (target === undefined) {
      return { connectionId, status: 'skipped', reason: 'not a browser-transport connection' };
    }

    let outcome: { status: string; reason?: string };
    const sequence = this.deps.nextSequence();
    try {
      outcome = await this.deps.probe(connectionId, target.whoami);
    } catch (e) {
      return isTimeout(e)
        ? this.failure(connectionId, 'timeout', 'probe.timeout', e)
        : this.failure(connectionId, 'error', 'probe.error', e);
    }

    // An admin may pause while the network probe is running. Never restore
    // capability state for that connection after the pause took effect.
    if (connection.paused) return { connectionId, status: 'skipped', reason: 'connection is paused' };
    if (this.deps.connectionMap.get(connectionId) !== connection || connection.updated_at !== revision || connection.capability_states !== previousStates) {
      return { connectionId, status: 'skipped', reason: 'connection changed while probing' };
    }

    if (!SUPPORT_STATUSES.has(outcome.status)) {
      return this.failure(
        connectionId, 'error', 'probe.error',
        new Error(`unknown probe status: ${outcome.status}`),
      );
    }
    const status = outcome.status as SupportStatus;
    const probedAt = this.nowIso();
    const next = this.nextStates(connection.capability_states, target, status, outcome.reason, probedAt);

    try {
      const saved = await this.deps.db.rawRun('UPDATE connections SET capability_states=? WHERE id=? AND updated_at=? AND capability_states=?', [JSON.stringify(next), connectionId, revision, JSON.stringify(previousStates)]);
      if (!saved.changes) return { connectionId, status: 'skipped', reason: 'connection changed while probing' };
    } catch (e) {
      this.deps.audit({
        action: 'probe.persist_failed',
        target: connectionId,
        detail: { status, error: errorMessage(e) },
      });
    }
    if (this.deps.connectionMap.get(connectionId) !== connection || connection.updated_at !== revision || connection.capability_states !== previousStates) {
      return { connectionId, status: 'skipped', reason: 'connection changed while probing' };
    }
    // Authentication failures still block in memory when storage fails, but a
    // health observation never changes the settings revision or query cache.
    connection.capability_states = next;
    this.deps.onObserved?.(connectionId, target.whoami, sequence,
      Object.keys(next).filter(id => next[id] !== previousStates[id]));

    if (status === 'needs_auth') {
      this.deps.audit({
        action: 'probe.needs_auth',
        target: connectionId,
        detail: { whoami: target.whoami, upstream_reason: outcome.reason ?? null },
      });
      return { connectionId, status, reason: NEEDS_AUTH_REASON };
    }
    return withReason({ connectionId, status }, outcome.reason);
  }

  private nextStates(
    current: Record<string, SupportState>,
    target: ProbeTarget,
    status: SupportStatus,
    reason: string | undefined,
    probedAt: string,
  ): Record<string, SupportState> {
    const next: Record<string, SupportState> = { ...current };

    if (status === 'needs_auth') {
      const ids = new Set([...target.capabilities, target.whoami]);
      for (const id of ids) {
        if (['disabled', 'unsupported'].includes(current[id]?.status ?? '')) continue;
        next[id] = { status: 'needs_auth', reason: NEEDS_AUTH_REASON, probed_at: probedAt };
      }
      return next;
    }

    if (status === 'supported') {
      // Only whoami was exercised. Other capabilities still need their own
      // checks; successful login does not prove every adapter works.
      for (const [id, state] of Object.entries(next)) {
        if (state.status === 'needs_auth' || state.status === 'needs_adapter' && !state.probed_at) next[id] = { status: 'unverified' };
      }
    }

    if (['disabled', 'unsupported'].includes(current[target.whoami]?.status ?? '')) return next;
    const whoamiState: SupportState = { status, probed_at: probedAt };
    if (reason !== undefined) whoamiState.reason = reason;
    next[target.whoami] = whoamiState;
    return next;
  }

  private failure(
    connectionId: string,
    status: 'timeout' | 'error',
    action: string,
    e: unknown,
  ): ProbeResult {
    const message = errorMessage(e);
    this.deps.audit({ action, target: connectionId, detail: { error: message } });
    return { connectionId, status, reason: message };
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}
