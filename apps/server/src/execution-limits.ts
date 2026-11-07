import { err, fail, type Capability, type Connection, type ResultEnvelope } from '@owngate/core';

interface LimitState { requests: number[]; failures: number; openUntil: number; testing: boolean }
const TRANSIENT = new Set(['UPSTREAM_ERROR', 'UPSTREAM_TIMEOUT', 'TASK_TIMEOUT', 'BROWSER_UNAVAILABLE']);

/** Applied only to actual dispatches, after authorization and cache lookup. */
export class ExecutionLimits {
  private readonly states = new Map<string, LimitState>();
  constructor(private readonly options: { now?: () => number; failureThreshold?: number; cooldownMs?: number } = {}) {}
  reset(connectionId: string) { this.states.delete(connectionId); }
  snapshot(connectionId: string) {
    const state = this.states.get(connectionId), now = this.now();
    return { failures: state?.failures ?? 0, circuit: state && state.openUntil > now ? 'open' : state?.testing ? 'testing' : 'closed', retry_at: state && state.openUntil > now ? new Date(state.openUntil).toISOString() : null };
  }
  private now() { return (this.options.now ?? Date.now)(); }
  async run(connection: Connection, capability: Capability, rpm: number, execute: () => Promise<ResultEnvelope>) {
    const source = { connection_id: connection.id, connection_label: connection.label, capability_id: capability.id, support: connection.capability_states[capability.id] ?? capability.support };
    const state = this.states.get(connection.id) ?? { requests: [], failures: 0, openUntil: 0, testing: false };
    this.states.set(connection.id, state);
    const now = this.now();
    if (state.openUntil > now || state.testing) return fail(err('CIRCUIT_OPEN', '此连接连续查询失败，已暂时停止请求；请稍后重试或检查站点后恢复连接'), source);
    state.requests = state.requests.filter((time) => time > now - 60_000);
    const boundedRpm = Number.isFinite(rpm) && rpm > 0 ? Math.min(600, Math.max(1, Math.floor(rpm))) : 30;
    if (state.requests.length >= boundedRpm) return fail(err('RATE_LIMITED', `此连接已达到每分钟 ${boundedRpm} 次的查询上限，请稍后重试`), source);
    state.requests.push(now);
    // One probe enters the half-open state; the core also serializes requests
    // by connection, including requests coming from different entry points.
    const recovering = state.openUntil > 0;
    if (recovering) state.testing = true;
    let result: ResultEnvelope;
    try { result = await execute(); }
    catch { result = fail(err('INTERNAL_ERROR', '连接执行失败，请检查连接器'), source); }
    finally { state.testing = false; }
    if (result.error && TRANSIENT.has(result.error.code)) {
      state.failures++;
      if (recovering || state.failures >= (this.options.failureThreshold ?? 5)) state.openUntil = this.now() + (this.options.cooldownMs ?? 60_000);
    } else { state.failures = 0; state.openUntil = 0; }
    return result;
  }
}
