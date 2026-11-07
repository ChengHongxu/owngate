import type { Capability, Connection, ResultEnvelope } from '@owngate/core';
import type { CompiledConnector, OutputFieldDef } from '@owngate/connector-runtime';

export interface HttpDefinition {
  http: NonNullable<CompiledConnector['http']>;
  output?: Record<string, OutputFieldDef>;
  success_when?: string;
  auth_failed_when?: string;
  request: { method: string; path: string; query?: Record<string, string>; readonly_paths?: string[] };
  discovery?: CompiledConnector['discovery'];
}
export interface HttpJob {
  connection: Connection;
  capability: Capability;
  input: unknown;
  definition: HttpDefinition;
  broker_url: string;
  timeout_ms: number;
}
export interface RuntimeRequest { id: string; job: HttpJob }
export interface RuntimeResponse { id: string; result?: ResultEnvelope; error?: 'CONNECTOR_CRASHED' | 'UPSTREAM_TIMEOUT' }
