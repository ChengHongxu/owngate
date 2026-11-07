import { randomUUID } from 'node:crypto';
import { err } from '@owngate/core';
import type { ApiError } from '@owngate/core';
import type { DbClient } from '@owngate/db';

export interface McpPin {
  id: string;
  client_id: string;
  name: string;
  connection_id: string;
  capability_id: string;
  created_at: string;
}
export type McpPinInput = Pick<McpPin, 'client_id' | 'name' | 'connection_id' | 'capability_id'>;

export class McpPinError extends Error {
  constructor(readonly statusCode: number, readonly error: ApiError) { super(error.message); this.name = 'McpPinError'; }
}

/** Metadata only. Schemas and access come from the current registry and grants
 * on every discovery/call, so a pin never preserves an old permission. */
export class McpPinStore {
  private initialized: Promise<void> | undefined;
  constructor(private readonly db: Pick<DbClient, 'rawRun' | 'rawQuery'>) {}

  init(): Promise<void> {
    return this.initialized ??= this.db.rawRun(`CREATE TABLE IF NOT EXISTS og_mcp_pins (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      capability_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(client_id, name)
    )`).then(() => undefined);
  }
  async list(clientId?: string): Promise<McpPin[]> {
    await this.init();
    return await this.db.rawQuery(`SELECT id, client_id, name, connection_id, capability_id, created_at FROM og_mcp_pins${clientId === undefined ? '' : ' WHERE client_id = ?'} ORDER BY created_at, id`, clientId === undefined ? [] : [clientId]) as McpPin[];
  }
  async get(id: string): Promise<McpPin | undefined> {
    await this.init();
    return (await this.db.rawQuery('SELECT id, client_id, name, connection_id, capability_id, created_at FROM og_mcp_pins WHERE id = ?', [id]))[0] as McpPin | undefined;
  }
  async create(input: McpPinInput): Promise<McpPin> {
    await this.init();
    const pin: McpPin = { ...input, id: `mcp_${randomUUID()}`, created_at: new Date().toISOString() };
    try {
      // A single SQLite statement also enforces the limit for concurrent requests.
      const result = await this.db.rawRun(`INSERT INTO og_mcp_pins(id,client_id,name,connection_id,capability_id,created_at)
        SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM og_mcp_pins WHERE client_id = ?) < 10`,
      [pin.id, pin.client_id, pin.name, pin.connection_id, pin.capability_id, pin.created_at, pin.client_id]);
      if (result.changes !== 1) throw new McpPinError(409, err('INVALID_PARAMS', '每个客户端最多固定 10 个 MCP 查询工具，请先移除一个。'));
    } catch (error) {
      if (error instanceof McpPinError) throw error;
      throw new McpPinError(409, err('INVALID_PARAMS', '无法固定工具：名称重复或客户端、连接已失效。'));
    }
    return pin;
  }
  async remove(id: string): Promise<boolean> {
    await this.init();
    return (await this.db.rawRun('DELETE FROM og_mcp_pins WHERE id = ?', [id])).changes === 1;
  }
}
