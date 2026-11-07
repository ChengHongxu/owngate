// Browser worker RPC client — design doc §13.1, callable from dispatcher/admin/probe.
// This file creates the BrowserClient interface and a factory that returns an
// implementation backed by the real HMAC-signed HTTP client. Tests inject fake
// implementations.

import type { FieldMeta, ExecutionStep } from '@owngate/core';
import { createHmac, randomBytes } from 'node:crypto';
import type { LoginCondition as RuntimeLoginCondition } from '@owngate/connector-runtime';

// Re-export for convenience
export type LoginCondition = RuntimeLoginCondition;

const DEFAULT_DEADLINE_MS = 30_000;

export interface EgressPolicy { allowed_domains: string[]; strict: boolean }

export interface LoginStartRequest {
  egress_policy?: EgressPolicy;
  connection_id: string;
  url: string;
  success_when: LoginCondition[];
  qr_selector?: string;
  deadline_ms?: number;
}

export interface LoginStatusResult {
  status: 'pending' | 'success' | 'timeout' | 'idle';
  reason?: string;
  since: string;
}

export interface CookieItem {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface CookieImportResult {
  logged_in: boolean;
  cookies: { name: string; domain: string }[];
}

export interface ProbeRequest {
  egress_policy?: EgressPolicy;
  connection_id: string;
  connector_id?: string;
  login_url: string;
  success_when: LoginCondition[];
  whoami?: string;
  deadline_ms?: number;
}

export interface CheckRequest {
  egress_policy?: EgressPolicy;
  connection_id: string;
  connector_id?: string;
  exec_id: string;
  capability: string;
  params: unknown;
  deadline_ms?: number;
  /** Server-owned administrator diagnostics, not caller-selected RPC data. */
  diagnostics?: boolean;
}

export interface CheckResult {
  status: 'ok' | 'error';
  data?: unknown;
  error?: { code: string; what_happened: string; next_step: string; retryable: boolean };
  meta?: unknown;
  partial?: boolean;
  fields?: Record<string, FieldMeta>;
  warnings?: string[];
  item_errors?: { index: number; code: string; reason: string }[];
  diagnostics?: ExecutionStep[];
}

/** The public interface for calling the browser worker. */
export interface BrowserClient {
  openSession(connectionId: string, egressPolicy?: EgressPolicy): Promise<{ session_id: string }>;
  closeSession(connectionId: string): Promise<{ ok: boolean }>;
  resumeSafety?(connectionId: string): Promise<{ ok: boolean }>;
  startLogin(req: LoginStartRequest): Promise<{ stream_token: string }>;
  stopLogin(connectionId: string): Promise<{ ok: boolean }>;
  loginStatus(connectionId: string): Promise<LoginStatusResult>;
  importCookies(
    connectionId: string,
    cookies: CookieItem[],
    successWhen?: LoginCondition[],
    egressPolicy?: EgressPolicy,
  ): Promise<CookieImportResult>;
  check(req: CheckRequest): Promise<CheckResult>;
  probe(req: ProbeRequest): Promise<{ status: string; reason?: string; account?: unknown; connection_status?: 'paused' | 'needs_auth'; error_code?: string }>;
  /** Opens the signed screencast WebSocket (GET /v1/screencast?token=...). */
  openScreencast(streamToken: string): WebSocket;
}

export interface BrowserClientConfig {
  baseUrl: string;
  secret: string;
}

/** Factory: wires the real HTTP client. Tests inject fake clients instead. */
export function createBrowserClient(config: BrowserClientConfig): BrowserClient {
  const baseUrl = config.baseUrl.replace(/\/$/, '');

  // Bind the complete request and a one-use nonce (§13.1), including upgrades.
  function sign(method: string, path: string, body = ''): Record<string, string> {
    const ts = Date.now().toString();
    const nonce = randomBytes(16).toString('hex');
    const payload = JSON.stringify([method.toUpperCase(), path, ts, nonce, body]);
    const sig = createHmac('sha256', config.secret).update(payload).digest('hex');
    return { 'X-Og-Sig': sig, 'X-Og-Ts': ts, 'X-Og-Nonce': nonce };
  }

  async function rpcPost<T>(path: string, payload: unknown, deadlineMs = DEFAULT_DEADLINE_MS): Promise<T> {
    const body = JSON.stringify(payload);
    const headers = sign('POST', path, body);
    const resp = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body,
      signal: AbortSignal.timeout(deadlineMs),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`browser RPC ${path} → ${resp.status}: ${text}`);
    }
    return resp.json() as Promise<T>;
  }

  async function rpcGet<T>(path: string, deadlineMs = DEFAULT_DEADLINE_MS): Promise<T> {
    const headers = sign('GET', path);
    const resp = await fetch(`${baseUrl}${path}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(deadlineMs),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`browser RPC ${path} → ${resp.status}: ${text}`);
    }
    return resp.json() as Promise<T>;
  }

  function rpcWithDeadline<T>(path: string, req: CheckRequest | ProbeRequest): Promise<T> {
    const deadlineMs = req.deadline_ms ?? DEFAULT_DEADLINE_MS;
    return rpcPost(path, { ...req, deadline_ms: deadlineMs }, deadlineMs);
  }

  return {
    openSession: (connectionId, egressPolicy) => rpcPost('/v1/session/open', { connection_id: connectionId, ...(egressPolicy ? { egress_policy: egressPolicy } : {}) }),
    resumeSafety: (connectionId) => rpcPost('/v1/safety/resume', { connection_id: connectionId }),
    closeSession: (connectionId) => rpcPost('/v1/session/close', { connection_id: connectionId }),
    startLogin: (req) => rpcPost('/v1/login/start', req, req.deadline_ms),
    stopLogin: (connectionId) => rpcPost('/v1/login/stop', { connection_id: connectionId }),
    loginStatus: (connectionId) => rpcGet(`/v1/login/status?connection_id=${encodeURIComponent(connectionId)}`),
    importCookies: (connectionId, cookies, successWhen, egressPolicy) =>
      rpcPost('/v1/cookies/import', {
        connection_id: connectionId,
        cookies,
        ...(successWhen !== undefined ? { success_when: successWhen } : {}),
        ...(egressPolicy ? { egress_policy: egressPolicy } : {}),
      }),
    check: (req) => rpcWithDeadline('/v1/check', req),
    probe: (req) => rpcWithDeadline('/v1/probe', req),
    openScreencast: (streamToken) => {
      const path = '/v1/screencast?token=' + encodeURIComponent(streamToken);
      const headers = sign('GET', path);
      return new WebSocket(baseUrl + path, { headers });
    },
  };
}
