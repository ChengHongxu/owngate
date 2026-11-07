// Browser HTTP dispatcher — calls owngate-browser RPC (design doc §13.1)
// Replaces the M0 stub dispatcher for browser-transport capabilities.
// §13.1 error mapping: worker JSON errors with code in ErrorCode pass through;
// unknown worker codes → INTERNAL_ERROR; transport failures → UPSTREAM_TIMEOUT
// or BROWSER_UNAVAILABLE depending on the error.

import { randomUUID } from 'node:crypto';
import type { Connection, Capability, ErrorCode, ResultEnvelope } from '@owngate/core';
import { err, fail, ok, CODE_CLASSIFICATION } from '@owngate/core';
import type { BrowserClient, CheckRequest } from '../browser-client.js';
import type { EgressPolicy } from '../browser-client.js';
import { executionDiagnosticsEnabled, recordWorkerDiagnostics } from '../execution-trace.js';

const DEFAULT_DEADLINE_MS = 30_000;

// ── Dispatcher ─────────────────────────────────────────────────────────────

export async function dispatchBrowser(
  browserClient: BrowserClient,
  connection: Connection,
  capability: Capability,
  input: unknown,
  policy?: EgressPolicy,
): Promise<ResultEnvelope> {
  const execId = randomUUID();
  const source = {
    connection_id: connection.id,
    connection_label: connection.label,
    capability_id: capability.id,
    support: connection.capability_states[capability.id] ?? capability.support,
  };

  const req: CheckRequest = {
    connection_id: connection.id,
    exec_id: execId,
    capability: capability.id,
    connector_id: connection.connector_id,
    params: input,
    deadline_ms: DEFAULT_DEADLINE_MS,
    ...(policy ? { egress_policy: policy } : {}),
    ...(executionDiagnosticsEnabled() ? { diagnostics: true } : {}),
  };

  let result: Awaited<ReturnType<BrowserClient['check']>>;
  try {
    result = await browserClient.check(req);
  } catch (e) {
    // §13.1 error mapping: transport-layer failures map to ErrorCode based on
    // error type (timeout/abort → UPSTREAM_TIMEOUT; connection refused/network
    // → BROWSER_UNAVAILABLE). String matching from old code is removed.
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout =
      e instanceof Error &&
      (e.name === 'TimeoutError' || e.name === 'AbortError' || /timeout|timed out/i.test(msg));
    const code = isTimeout ? 'UPSTREAM_TIMEOUT' : 'BROWSER_UNAVAILABLE';
    return fail(err(code, `Browser RPC failed: ${msg}`), source);
  }

  recordWorkerDiagnostics(result.diagnostics);
  const warnings = [...(result.warnings ?? []), ...(result.item_errors ?? []).map((error) => `ITEM_PARSE_FAILED · 第 ${error.index + 1} 条：${error.reason}`)];

  if (result.status === 'error') {
    const rpcErr = result.error;
    if (rpcErr === undefined) {
      return fail(err('INTERNAL_ERROR', 'Browser capability execution failed'), source, { warnings });
    }
    // §13.1: code in ErrorCode → pass through; otherwise INTERNAL_ERROR.
    const isKnown = Object.hasOwn(CODE_CLASSIFICATION, rpcErr.code);
    const code: ErrorCode = isKnown ? rpcErr.code as ErrorCode : 'INTERNAL_ERROR';
    const paused = (result.meta as { connection_status?: string } | undefined)?.connection_status === 'paused';
    // A worker may narrow a transient error (for example, a local account
    // cooldown), but cannot make auth/risk errors automatically retryable.
    const retryable = CODE_CLASSIFICATION[code].retryable &&
      (!isKnown || typeof rpcErr.retryable !== 'boolean' || rpcErr.retryable);
    const details = {
      ...(paused ? { connection_status: 'paused' } : {}),
      ...(isKnown && typeof rpcErr.next_step === 'string' && rpcErr.next_step.trim() ? { next_step: rpcErr.next_step } : {}),
    };
    return fail(err(code, rpcErr.what_happened, {
      retryable,
      ...(Object.keys(details).length ? { details } : {}),
    }), source, { warnings });
  }

  const envelope = ok(result.data, source, {
    ...(result.fields ? { fields: result.fields } : {}),
    warnings,
  });
  if (result.partial) { envelope.outcome = 'partial'; envelope.status = 'partial'; }
  return envelope;
}
