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
// Timer: plain setInterval. croner is not a dependency of @webridge/server yet;
// a fixed interval needs no cron expression, so this avoids a new package.

import type { Connection, SupportState, SupportStatus } from '@webridge/core';
import type { DbClient } from '@webridge/db';

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
  db: Pick<DbClient, 'updateConnectionStates'>;
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
  'supported', 'partial', 'needs_auth', 'needs_plan', 'needs_adapter', 'unsupported', 'disabled',
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
    try {
      outcome = await this.deps.probe(connectionId, target.whoami);
    } catch (e) {
      return isTimeout(e)
        ? this.failure(connectionId, 'timeout', 'probe.timeout', e)
        : this.failure(connectionId, 'error', 'probe.error', e);
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

    // Memory first: invoke() reads connectionMap, so a needs_auth result must
    // block calls even if the DB write below fails.
    connection.capability_states = next;
    connection.updated_at = probedAt;

    try {
      await this.deps.db.updateConnectionStates(connectionId, next, probedAt);
    } catch (e) {
      this.deps.audit({
        action: 'probe.persist_failed',
        target: connectionId,
        detail: { status, error: errorMessage(e) },
      });
    }

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
        next[id] = { status: 'needs_auth', reason: NEEDS_AUTH_REASON, probed_at: probedAt };
      }
      return next;
    }

    if (status === 'supported') {
      // Login is valid again: drop needs_auth overrides so each capability
      // falls back to its connector default. Other overrides (disabled,
      // needs_plan, ...) were set for other reasons and stay.
      for (const [id, state] of Object.entries(next)) {
        if (state.status === 'needs_auth') delete next[id];
      }
    }

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
