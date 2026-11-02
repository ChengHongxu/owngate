// Browser HTTP dispatcher — calls webridge-browser RPC (design doc §13.1)
// Replaces the M0 stub dispatcher for browser-transport capabilities.
// §13.1 error mapping: worker JSON errors with code in ErrorCode pass through;
// unknown worker codes → INTERNAL_ERROR; transport failures → UPSTREAM_TIMEOUT
// or BROWSER_UNAVAILABLE depending on the error.

import { randomUUID } from 'node:crypto';
import type { Connection, Capability, ResultEnvelope } from '@webridge/core';
import { err, fail, ok, CODE_CLASSIFICATION } from '@webridge/core';
import type { BrowserClient, CheckRequest } from '../browser-client.js';

const DEFAULT_DEADLINE_MS = 30_000;

// ── Dispatcher ─────────────────────────────────────────────────────────────

export async function dispatchBrowser(
  browserClient: BrowserClient,
  connection: Connection,
  capability: Capability,
  input: unknown,
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
    params: input,
    deadline_ms: DEFAULT_DEADLINE_MS,
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

  if (result.status === 'error') {
    const rpcErr = result.error;
    if (rpcErr === undefined) {
      return fail(err('INTERNAL_ERROR', 'Browser capability execution failed'), source);
    }
    // §13.1: code in ErrorCode → pass through; otherwise INTERNAL_ERROR.
    const isKnown = rpcErr.code in CODE_CLASSIFICATION;
    const code = isKnown ? rpcErr.code : 'INTERNAL_ERROR';
    return fail(err(code as Parameters<typeof err>[0], rpcErr.what_happened), source);
  }

  return ok(result.data, source);
}
