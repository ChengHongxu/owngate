// Browser worker RPC client — design doc §13.1, callable from dispatcher/admin/probe.
// This file creates the BrowserClient interface and a factory that returns an
// implementation backed by the real HMAC-signed HTTP client. Tests inject fake
// implementations.

import { createHmac } from 'node:crypto';
import type { LoginCondition as RuntimeLoginCondition } from '@webridge/connector-runtime';

// Re-export for convenience
export type LoginCondition = RuntimeLoginCondition;

const DEFAULT_DEADLINE_MS = 30_000;

export interface LoginStartRequest {
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
  connection_id: string;
  login_url: string;
  success_when: LoginCondition[];
  whoami?: string;
  deadline_ms?: number;
}

export interface CheckRequest {
  connection_id: string;
  exec_id: string;
  capability: string;
  params: unknown;
  deadline_ms?: number;
}

export interface CheckResult {
  status: 'ok' | 'error';
  data?: unknown;
  error?: { code: string; what_happened: string; next_step: string; retryable: boolean };
  meta?: unknown;
}

/** The public interface for calling the browser worker. */
export interface BrowserClient {
  openSession(connectionId: string): Promise<{ session_id: string }>;
  closeSession(connectionId: string): Promise<{ ok: boolean }>;
  startLogin(req: LoginStartRequest): Promise<{ stream_token: string }>;
  stopLogin(connectionId: string): Promise<{ ok: boolean }>;
  loginStatus(connectionId: string): Promise<LoginStatusResult>;
  importCookies(
    connectionId: string,
    cookies: CookieItem[],
    successWhen?: LoginCondition[],
  ): Promise<CookieImportResult>;
  check(req: CheckRequest): Promise<CheckResult>;
  probe(req: ProbeRequest): Promise<{ status: string; reason?: string; account?: unknown }>;
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

  // §13.1: POSTs sign the raw body; GETs (including WebSocket upgrades) sign path+query.
  // Must match apps/browser/src/auth.ts.
  function signBody(body: string): { 'X-Wr-Sig': string; 'X-Wr-Ts': string } {
    const ts = Date.now().toString();
    const sig = createHmac('sha256', config.secret).update(body).digest('hex');
    return { 'X-Wr-Sig': sig, 'X-Wr-Ts': ts };
  }

  function signGet(pathAndQuery: string): { 'X-Wr-Sig': string; 'X-Wr-Ts': string } {
    const ts = Date.now().toString();
    const sig = createHmac('sha256', config.secret).update(pathAndQuery).digest('hex');
    return { 'X-Wr-Sig': sig, 'X-Wr-Ts': ts };
  }

  async function rpcPost<T>(path: string, payload: unknown, deadlineMs = DEFAULT_DEADLINE_MS): Promise<T> {
    const body = JSON.stringify(payload);
    const headers = signBody(body);
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
    const headers = signGet(path);
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

  return {
    openSession: (connectionId) => rpcPost('/v1/session/open', { connection_id: connectionId }),
    closeSession: (connectionId) => rpcPost('/v1/session/close', { connection_id: connectionId }),
    startLogin: (req) => rpcPost('/v1/login/start', req, req.deadline_ms),
    stopLogin: (connectionId) => rpcPost('/v1/login/stop', { connection_id: connectionId }),
    loginStatus: (connectionId) => rpcGet(`/v1/login/status?connection_id=${encodeURIComponent(connectionId)}`),
    importCookies: (connectionId, cookies, successWhen) =>
      rpcPost('/v1/cookies/import', {
        connection_id: connectionId,
        cookies,
        ...(successWhen !== undefined ? { success_when: successWhen } : {}),
      }),
    check: (req) => rpcPost('/v1/check', req, req.deadline_ms),
    probe: (req) => rpcPost('/v1/probe', req, req.deadline_ms),
    openScreencast: (streamToken) => {
      const path = '/v1/screencast?token=' + encodeURIComponent(streamToken);
      const headers = signGet(path);
      return new WebSocket(baseUrl + path, { headers });
    },
  };
}
