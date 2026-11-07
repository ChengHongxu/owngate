// Core domain types — the canonical vocabulary shared across all packages.
// Nothing here may import from other @owngate packages.

export type Effect = 'read' | 'write' | 'destructive' | 'external_send' | 'financial';

export type CapabilityKind = 'query' | 'action';

export type ApprovalPolicy = 'never' | 'always' | 'policy';

export type CancelPolicy = 'none' | 'local_only' | 'remote';

export type IdempotencyPolicy = 'native' | 'verify' | 'none';

export type Transport = 'http' | 'browser';

export type SupportStatus =
  | 'supported'
  | 'partial'
  | 'unverified'
  | 'unavailable'
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

/** A connection summary, kept separate from an individual capability's state. */
export interface ConnectionHealth {
  status: 'healthy' | 'partial' | 'unverified' | 'needs_auth' | 'needs_adapter' | 'unavailable' | 'needs_plan' | 'disabled' | 'unsupported' | 'paused';
  reason?: string;
}

/** JSON Schema (draft-07 subset) with x-* extension keywords */
export type JSONSchema = Record<string, unknown>;

/** Static display binding into an already authorized result; never executable. */
export interface PresentationField {
  path: string;
  label?: string;
  format?: 'text' | 'number' | 'datetime' | 'link' | 'badge';
  prominent?: boolean;
}

export interface ResultPresentation {
  type: 'auto' | 'stats' | 'table' | 'list' | 'feed' | 'json';
  items?: string;
  fields?: PresentationField[];
  columns?: PresentationField[];
  max_rows?: number;
}

/** A bounded composition of read-only capabilities, not an authorization grant. */
export interface ComparisonView {
  id: string;
  type: 'comparison';
  title: string;
  description?: string;
  source: {
    capability: string;
    items: string;
    id: string;
    label?: string;
    value: string;
    updated_at: string;
    updated_at_format: 'unix_seconds' | 'iso8601';
    unit: { config: string; allowed: string[] };
  };
  detail: { capability: string; input: string; id: string };
  target: { capability: string; value: string };
}

/** Explicit default checks and the one check that establishes site authentication. */
export interface VerificationPlan {
  capabilities: string[];
  auth?: string;
}

export interface Capability {
  id: string;
  kind: CapabilityKind;
  title: string;
  description: string;
  effect: Effect;
  approval: ApprovalPolicy;
  input: JSONSchema;
  output: JSONSchema;
  presentation?: ResultPresentation;
  cache: { ttl: number } | null;
  long_running: boolean;
  cancel: CancelPolicy;
  idempotency: IdempotencyPolicy;
  /** id of a query capability used to verify an action's outcome */
  verify: string | null;
  transport: Transport;
  support: SupportState;
  /** Site account role required by this capability; omitted means either. */
  roles?: Array<'user' | 'admin'>;
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
  paused?: boolean;
  scope?: 'personal' | 'organization';
  tags?: string[];
  created_at: string;
  updated_at: string;
}

export interface Client {
  id: string;
  label: string;
  revoked: boolean;
  expires_at?: string | null;
  created_at: string;
}

export interface Grant {
  client_id: string;
  connection_id: string;
  /** capability ids; '*' means all supported query capabilities */
  capabilities: string[];
  visibility?: { pii?: boolean; financial?: boolean; content?: boolean };
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
  result?: import('../envelope/index.js').ResultEnvelope | null;
  attempts?: number;
  max_attempts?: number;
  cancellation?: TaskCancellation | null;
}

export interface TaskCancellation {
  state: 'cancelled_before_send' | 'cancelled_local';
  remote_confirmed: false;
  may_continue_remote: boolean;
}
