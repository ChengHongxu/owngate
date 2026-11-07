// Message types shared between the DB worker and DbClient.

export interface DbRequest {
  id: number;
  method: string;
  args: unknown;
}

export interface DbResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Trusted server-side SQL only; never accept this structure from an API body. */
export interface RawStatement {
  sql: string;
  params?: unknown[];
  mode?: 'run' | 'all' | 'get';
  /** A mismatched write count aborts and rolls back the complete transaction. */
  expectChanges?: number;
}

export interface RawRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}
