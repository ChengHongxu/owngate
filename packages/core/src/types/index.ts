// Core domain types — the canonical vocabulary shared across all packages.
// Nothing here may import from other @webridge packages.

export type Effect = 'read' | 'write' | 'destructive' | 'external_send' | 'financial';

export type CapabilityKind = 'query' | 'action';

export type ApprovalPolicy = 'never' | 'always' | 'policy';

export type CancelPolicy = 'none' | 'local_only' | 'remote';

export type IdempotencyPolicy = 'native' | 'verify' | 'none';

export type Transport = 'http' | 'browser';

export type SupportStatus =
  | 'supported'
  | 'partial'
  | 'needs_auth'
  | 'needs_plan'
  | 'needs_adapter'
  | 'unsupported'
  | 'disabled';

export interface SupportState {
  status: SupportStatus;
  reason?: string;
  /** ISO timestamp of last probe */
  probed_at?: string;
}

/** JSON Schema (draft-07 subset) with x-* extension keywords */
export type JSONSchema = Record<string, unknown>;

export interface Capability {
  id: string;
  kind: CapabilityKind;
  title: string;
  description: string;
  effect: Effect;
  approval: ApprovalPolicy;
  input: JSONSchema;
  output: JSONSchema;
  cache: { ttl: number } | null;
  long_running: boolean;
  cancel: CancelPolicy;
  idempotency: IdempotencyPolicy;
  /** id of a query capability used to verify an action's outcome */
  verify: string | null;
  transport: Transport;
  support: SupportState;
}

export interface Connector {
  id: string;
  version: string;
  title: string;
  transport: Transport;
  capabilities: Record<string, Capability>;
}

export interface Connection {
  id: string;
  connector_id: string;
  label: string;
  config: Record<string, unknown>;
  /** per-capability support states (overrides connector defaults) */
  capability_states: Record<string, SupportState>;
  created_at: string;
  updated_at: string;
}

export type ClientKind = 'mcp' | 'cli' | 'admin' | 'cron';

export interface Client {
  id: string;
  label: string;
  kind: ClientKind;
  revoked: boolean;
  created_at: string;
}

export interface Grant {
  client_id: string;
  connection_id: string;
  /** capability ids; '*' means all supported query capabilities */
  capabilities: string[];
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'unknown_outcome';

export interface Task {
  id: string;
  client_id: string;
  connection_id: string;
  capability_id: string;
  input: unknown;
  status: TaskStatus;
  created_at: string;
  started_at?: string;
  finished_at?: string;
}
