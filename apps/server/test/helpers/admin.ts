// Test helpers for the admin gate (§8.4): a real admin session obtained the
// same way the web UI does, optionally upgraded with a TOTP step-up.
//
//   bootstrap → /auth/bootstrap (first run only)
//   login     → /auth/login, returns the wr_session cookie
//   step-up   → /auth/totp/enroll → /auth/totp/confirm → /auth/step-up/totp
//
// TOTP codes come from src/auth/totp.ts, so no clock mocking is needed.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { totpAt } from '../../src/auth/totp.js';
import { SESSION_COOKIE } from '../../src/auth/guard.js';

export const ADMIN_USERNAME = 'admin';
export const ADMIN_PASSWORD = 'correct horse battery';

export interface AdminSession {
  /** `wr_session=<id>`, ready for a Cookie header. */
  cookie: string;
  /** Spread into app.inject({ headers }). */
  headers: { cookie: string };
  /** Base32 TOTP secret once step-up has been set up. */
  totpSecret?: string;
}

/** A fresh SQLite path in its own temp dir, plus a cleanup function. */
export function tempDbPath(prefix = 'webridge-test-'): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    path: join(dir, 'webridge.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function currentTotp(secretBase32: string): string {
  return totpAt(secretBase32, Math.floor(Date.now() / 1000));
}

function sessionCookieFrom(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  if (cookie === undefined) {
    throw new Error(`no ${SESSION_COOKIE} cookie (HTTP ${res.statusCode}): ${res.body}`);
  }
  return `${SESSION_COOKIE}=${cookie.value}`;
}

function expectOk(res: LightMyRequestResponse, what: string): void {
  if (res.statusCode >= 300) throw new Error(`${what} failed (HTTP ${res.statusCode}): ${res.body}`);
}

function session(cookie: string, totpSecret?: string): AdminSession {
  return {
    cookie,
    headers: { cookie },
    ...(totpSecret !== undefined ? { totpSecret } : {}),
  };
}

/**
 * Log in as the test admin, bootstrapping it on a fresh DB. Pass the TOTP
 * secret when the admin already enrolled TOTP (e.g. after a server restart).
 */
export async function loginAdmin(app: FastifyInstance, totpSecret?: string): Promise<AdminSession> {
  const status = await app.inject({ method: 'GET', url: '/auth/status' });
  if ((status.json() as { hasUser: boolean }).hasUser === false) {
    const boot = await app.inject({
      method: 'POST',
      url: '/auth/bootstrap',
      payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    expectOk(boot, 'bootstrap');
  }

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: {
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
      ...(totpSecret !== undefined ? { totp: currentTotp(totpSecret) } : {}),
    },
  });
  expectOk(login, 'login');
  return session(sessionCookieFrom(login), totpSecret);
}

/**
 * Pass step-up for the session via TOTP, enrolling TOTP first when the
 * session does not carry a secret yet. Returns the session with its secret.
 */
export async function stepUp(app: FastifyInstance, admin: AdminSession): Promise<AdminSession> {
  let secret = admin.totpSecret;
  if (secret === undefined) {
    const enroll = await app.inject({ method: 'POST', url: '/auth/totp/enroll', headers: admin.headers });
    expectOk(enroll, 'totp enroll');
    secret = (enroll.json() as { secretBase32: string }).secretBase32;
    const confirm = await app.inject({
      method: 'POST',
      url: '/auth/totp/confirm',
      headers: admin.headers,
      payload: { code: currentTotp(secret) },
    });
    expectOk(confirm, 'totp confirm');
  }
  const up = await app.inject({
    method: 'POST',
    url: '/auth/step-up/totp',
    headers: admin.headers,
    payload: { code: currentTotp(secret) },
  });
  expectOk(up, 'step-up');
  return session(admin.cookie, secret);
}

/** Login + step-up in one call: the session most admin-route tests need. */
export async function adminWithStepUp(app: FastifyInstance, totpSecret?: string): Promise<AdminSession> {
  return stepUp(app, await loginAdmin(app, totpSecret));
}
