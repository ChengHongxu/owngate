// Unified connection state write-back — design §4.5, called by dispatcher/probe.
// "把某连接的全部能力标成某状态"：同时更新 connectionMap 与 db.updateConnectionStates.
// Write-back timing:
//   (a) dispatcher returns AUTH_ERRORS → needs_auth
//   (b) RISK_CONTROL_DETECTED → also needs_auth, reason 写固定文案（§4.5连接级paused属于M2）
//   (c) login success / cookie import logged_in / probe supported → all capabilities back to supported

import type { Connection, SupportState, ErrorCode } from '@webridge/core';
import type { DbClient } from '@webridge/db';

const AUTH_ERRORS: ReadonlySet<ErrorCode> = new Set([
  'AUTH_EXPIRED',
  'AUTH_MISSING',
  'LOGIN_REQUIRED',
  'CAPTCHA_PRESENT',
]);

const RISK_CONTROL_REASON = '命中风控，连接已暂停，请人工检查账号';

export type StateWriterFn = (
  connectionId: string,
  errorCode?: ErrorCode,
  opts?: { restore?: boolean },
) => Promise<void>;

/**
 * Build the state write-back function that updates both the connection map and
 * the DB. Called by dispatcher (error-code-driven write-back) and probe
 * (restore to supported).
 *
 * §4.5 timing:
 * - AUTH_ERRORS → mark all capabilities needs_auth
 * - RISK_CONTROL_DETECTED → also needs_auth with the fixed reason
 * - { restore: true } → drop needs_auth overrides; each capability falls back
 *   to its connector default (§probe supports this)
 */
export function createStateWriter(
  connectionMap: Map<string, Connection>,
  db: Pick<DbClient, 'updateConnectionStates'>,
  listCapabilities: (connectorId: string) => { id: string }[],
): StateWriterFn {
  return async (connectionId, errorCode, opts) => {
    const connection = connectionMap.get(connectionId);
    if (connection === undefined) return;

    const allCapIds = listCapabilities(connection.connector_id).map((c) => c.id);
    const next: Record<string, SupportState> = { ...connection.capability_states };
    const now = new Date().toISOString();

    if (opts?.restore === true) {
      // Restore: drop needs_auth overrides so each capability falls back to
      // the connector default.
      for (const [id, state] of Object.entries(next)) {
        if (state.status === 'needs_auth') delete next[id];
      }
    } else if (errorCode !== undefined) {
      // Error-driven write-back:
      if (AUTH_ERRORS.has(errorCode) || errorCode === 'RISK_CONTROL_DETECTED') {
        const reason = errorCode === 'RISK_CONTROL_DETECTED' ? RISK_CONTROL_REASON : undefined;
        for (const capId of allCapIds) {
          const state: SupportState = { status: 'needs_auth', probed_at: now };
          if (reason !== undefined) state.reason = reason;
          next[capId] = state;
        }
      }
    }

    // Memory first: invoke() reads connectionMap
    connection.capability_states = next;
    connection.updated_at = now;

    try {
      await db.updateConnectionStates(connectionId, next, now);
    } catch (e) {
      console.error(`[state-writer] DB write failed for ${connectionId}:`, (e as Error).message);
    }
  };
}
