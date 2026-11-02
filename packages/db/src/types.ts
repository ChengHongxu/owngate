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
