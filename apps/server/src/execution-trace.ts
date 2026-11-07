// Request-local administrator diagnostics. Business results remain trace-free.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { invoke, ERROR_TEXT, type AdminCaller, type ExecutionEvent, type ExecutionStep, type ExecutionTrace,
  type InvokeOptions, type InvokeRequest, type InvokeServices, type ResultEnvelope } from '@owngate/core';

interface PendingStep { step: ExecutionStep; started: number; finished: boolean }
const contexts = new AsyncLocalStorage<Collector>();
const MAX_STEPS = 48;

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  // Diagnostic messages do not need navigable URLs. Strip them entirely so
  // query strings, opaque handles and account paths cannot enter this channel.
  return value.replace(/https?:\/\/[^\s<>"']+/gi, '[网址已省略]').slice(0, max);
}

function diagnosticCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : undefined;
}

class Collector {
  readonly id = randomUUID();
  readonly startedAt = new Date().toISOString();
  readonly started = performance.now();
  private steps: PendingStep[] = [];
  private pending = new Map<string, PendingStep>();

  event = (event: ExecutionEvent): void => {
    if (event.type === 'start') {
      if (this.steps.length >= MAX_STEPS || this.pending.has(event.id)) return;
      const entry = { step: { id: event.id, label: boundedText(event.label, 80) ?? '执行步骤', status: 'skipped' as const, duration_ms: 0 },
        started: performance.now(), finished: false };
      this.steps.push(entry); this.pending.set(event.id, entry);
      return;
    }
    const entry = this.pending.get(event.id);
    if (!entry) return;
    const detail = boundedText(event.detail, 500), code = diagnosticCode(event.code);
    entry.step = { id: event.id, label: boundedText(event.label, 80) ?? '执行步骤', status: event.status,
      duration_ms: Number.isFinite(event.duration_ms) ? Math.max(0, Math.min(600_000, event.duration_ms)) : 0,
      ...(detail ? { detail } : {}), ...(code ? { code } : {}) };
    entry.finished = true;
    this.pending.delete(event.id);
  };

  importWorker(steps: unknown): void {
    if (!Array.isArray(steps)) return;
    for (const value of steps.slice(0, 24)) {
      if (!value || typeof value !== 'object' || this.steps.length >= MAX_STEPS) continue;
      const item = value as Record<string, unknown>;
      if (typeof item['id'] !== 'string' || !/^browser\.[a-z][a-z_]{0,32}$/.test(item['id'])) continue;
      const label = boundedText(item['label'], 80), detail = boundedText(item['detail'], 500);
      const status = item['status'];
      if (!label || !['success', 'partial', 'error', 'skipped'].includes(String(status)) ||
          typeof item['duration_ms'] !== 'number' || !Number.isFinite(item['duration_ms']) || item['duration_ms'] < 0) continue;
      const code = diagnosticCode(item['code']);
      this.steps.push({ started: performance.now(), finished: true,
        step: { id: item['id'], label, status: status as ExecutionStep['status'], duration_ms: Math.min(600_000, item['duration_ms']),
          ...(detail ? { detail } : {}), ...(code ? { code } : {}) } });
    }
  }

  trace(): ExecutionTrace {
    return { id: this.id, started_at: this.startedAt, duration_ms: Math.max(0, performance.now() - this.started),
      steps: this.steps.map(({ step, started, finished }) => finished ? step : {
        ...step, status: 'error', duration_ms: Math.max(0, performance.now() - started),
        detail: '此步骤未能返回结果', code: 'INTERNAL_ERROR',
      }) };
  }
}

/** Only the authenticated administrator route wiring calls this function. */
export async function invokeAdminWithTrace(
  request: InvokeRequest,
  services: InvokeServices,
  options: InvokeOptions,
  caller: AdminCaller,
): Promise<ResultEnvelope> {
  if (caller.kind !== 'admin' || !caller.user_id.trim()) return invoke(request, services, options, caller);
  const collector = new Collector();
  return contexts.run(collector, async () => {
    const result = await invoke(request, services, { ...options, onExecutionEvent: collector.event }, caller);
    // The trace is attached after invoke has cached, filtered and audited the
    // business result. Neither shared results nor an onAuthorizedResult sink
    // ever see these observations.
    const response = { ...result, execution: collector.trace() };
    try { return (options.sanitize?.(response) ?? response) as ResultEnvelope; }
    catch { return result; } // Optional observations must never break a query.
  });
}

export function executionDiagnosticsEnabled(): boolean { return contexts.getStore() !== undefined; }

/** Bind an internal broker callback to its originating administrator request. */
export function executionRecorder(): ((event: ExecutionEvent) => void) | undefined {
  const collector = contexts.getStore();
  return collector ? event => { try { collector.event(event); } catch { /* Optional diagnostics. */ } } : undefined;
}

export function recordWorkerDiagnostics(steps: unknown): void {
  contexts.getStore()?.importWorker(steps);
}

/** Observe a real server boundary, without inferring its unobserved internals. */
export async function observeExecution(
  id: string,
  label: string,
  action: () => Promise<ResultEnvelope>,
): Promise<ResultEnvelope> {
  const collector = contexts.getStore();
  if (!collector) return action();
  const started = performance.now();
  collector.event({ type: 'start', id, label });
  try {
    const result = await action();
    collector.event({ type: 'finish', id, label, duration_ms: Math.max(0, performance.now() - started),
      status: result.outcome === 'error' ? 'error' : result.outcome === 'partial' ? 'partial' : 'success',
      // Preserve the business error in its envelope; it can contain account
      // paths without a URL scheme or exception text unsuitable for traces.
      ...(result.error ? { detail: ERROR_TEXT[result.error.code]?.what_happened ?? '执行服务返回失败结果', code: result.error.code } : {}) });
    return result;
  } catch (error) {
    collector.event({ type: 'finish', id, label, status: 'error', duration_ms: Math.max(0, performance.now() - started),
      detail: '执行服务未能返回结果', code: 'INTERNAL_ERROR' });
    throw error;
  }
}
