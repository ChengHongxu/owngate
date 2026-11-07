// Account risk pauses a connection independently of individual query health.
import type { Connection, ErrorCode } from '@owngate/core';
import type { DbClient } from '@owngate/db';

export type StateWriterFn = (
  connectionId: string,
  errorCode?: ErrorCode,
  opts?: { paused?: boolean },
) => Promise<void>;

export function createStateWriter(
  connectionMap: Map<string, Connection>,
  db: Pick<DbClient, 'rawRun'>,
): StateWriterFn {
  return async (connectionId, errorCode, opts) => {
    if (errorCode !== 'RISK_CONTROL_DETECTED' && !opts?.paused) return;
    const connection = connectionMap.get(connectionId);
    if (connection === undefined) return;
    const now = new Date(Math.max(Date.now(), (Date.parse(connection.updated_at) || 0) + 1)).toISOString();
    // Fail closed in memory even if persisting the risk pause fails.
    connection.paused = true;
    connection.updated_at = now;
    try {
      await db.rawRun('UPDATE connections SET paused=1,updated_at=? WHERE id=?', [now, connectionId]);
    } catch (e) {
      console.error(`[state-writer] DB write failed for ${connectionId}:`, (e as Error).message);
    }
  };
}
