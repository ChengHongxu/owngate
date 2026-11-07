import type { Capability, Connection, InvokeRequest, ResultEnvelope } from '@owngate/core';
import type { Vault } from '@owngate/vault';

export interface MonitorDb {
  rawQuery(sql: string, params?: unknown[]): Promise<unknown[]>;
  rawRun(sql: string, params?: unknown[]): Promise<unknown>;
  rawTransaction(queries: Array<{ sql: string; params?: unknown[]; mode?: 'run' | 'all' | 'get' }>): Promise<unknown[]>;
}
export interface ChannelInput {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string[];
}
/** Plain only while in memory; the whole config is one context-bound blob. */
export interface StoredChannel extends Omit<ChannelInput, 'pass'> { pass?: string }
export interface ChannelView extends Omit<ChannelInput, 'pass'> {
  id: string;
  type: 'smtp';
  has_password: boolean;
  created_at: string;
}
export interface MonitorInput {
  label: string;
  connection_id: string;
  capability_id: string;
  cron: string;
  timezone: 'UTC';
  condition: string;
  mode: 'data' | 'failure';
  channel_id: string;
  cooldown_seconds: number;
  input: Record<string, unknown>;
  email_fields: string[];
  enabled: boolean;
}
export type Delivery = 'none' | 'sent' | 'failed' | 'suppressed';
export interface MonitorState {
  last_run_at: string | null;
  last_result: 'never' | 'running' | 'alert' | 'normal' | 'skipped' | 'error';
  last_status: string | null;
  last_error: string | null;
  active: boolean;
  false_streak: number;
  last_notification_at: string | null;
  delivery: Delivery;
  pending: 'alert' | 'recovery' | null;
}
export interface MonitorView extends MonitorInput {
  id: string;
  created_at: string;
  next_run_at: string | null;
  runtime: MonitorState;
}
export interface MonitorRunResult {
  monitor: MonitorView;
  result: { evaluation: 'alert' | 'normal' | 'skipped'; reason?: string; delivery: Delivery };
}
export interface MailMessage { from: string; to: string[]; subject: string; text: string }
export interface MailOptions {
  host: string; port: number; secure: boolean;
  auth?: { user: string; pass: string };
}
export type SendMail = (options: MailOptions, message: MailMessage) => Promise<void>;
export interface MonitorDeps {
  db: MonitorDb;
  vault: Vault;
  getConnection: (id: string) => Connection | undefined;
  getCapability: (connectionId: string, capabilityId: string) => Capability | undefined;
  /** Server-owned admin identity, cron visibility, no token supplied by HTTP. */
  invoke: (request: InvokeRequest, monitorId: string) => Promise<ResultEnvelope>;
  audit: (entry: { action: string; target?: string; detail?: unknown }) => void | Promise<void>;
  sendMail?: SendMail;
  now?: () => Date;
}
export class MonitorError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}
