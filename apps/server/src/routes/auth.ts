// Admin authentication routes — /auth/*
// Design doc §8.2 (recovery), §8.9 (audit), §7.2 (step-up), D8 (password + passkey + TOTP).
//
// Self-contained: registers @fastify/cookie itself so main.ts only has to call
// registerAuthRoutes(app, { auth, db }). The plugin breaks encapsulation (fastify-plugin),
// so cookies are parsed for routes registered after this call as well.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { randomBytes } from 'node:crypto';
import type { DbClient } from '@owngate/db';
import type { AuthService } from '../auth/service.js';
import {
  SESSION_COOKIE,
  sessionCookieOptions,
  requireAdminSession,
} from '../auth/guard.js';
import type { AdminSession } from '../auth/guard.js';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

interface RegisterAuthDeps {
  auth: AuthService;
  db: DbClient;
}

interface StatusBody {
  hasUser: boolean;
  authenticated: boolean;
  stepUp: boolean;
  totpEnabled: boolean;
  passkeyCount: number;
}

export async function registerAuthRoutes(app: FastifyInstance, deps: RegisterAuthDeps): Promise<void> {
  const { auth } = deps;
  const cookieOptions = sessionCookieOptions(auth.origin);

  await app.register(fastifyCookie);
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/auth/')) reply.header('Cache-Control', 'no-store');
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  function setSessionCookie(reply: FastifyReply, sessionId: string, expiresAt: string): void {
    reply.setCookie(SESSION_COOKIE, sessionId, {
      ...cookieOptions,
      expires: new Date(expiresAt),
    });
  }

  function clearSessionCookie(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  async function currentSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AdminSession | null> {
    return requireAdminSession(request, reply, auth);
  }

  /** Load the request body, returning a plain object regardless of schema coercion. */
  function bodyOf<T>(request: FastifyRequest): T {
    return (request.body ?? {}) as T;
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  app.get('/auth/status', async (request, reply): Promise<StatusBody> => {
    const hasUser = await auth.hasAnyUser();
    const status: StatusBody = {
      hasUser,
      authenticated: false,
      stepUp: false,
      totpEnabled: false,
      passkeyCount: 0,
    };

    const sessionId = request.cookies[SESSION_COOKIE];
    if (!hasUser || !sessionId) return status;

    const session = await auth.getSession(sessionId);
    if (!session) {
      clearSessionCookie(reply);
      return status;
    }

    status.authenticated = true;
    status.stepUp = await auth.hasStepUp(sessionId);
    status.totpEnabled = await auth.isTotpEnabled(session.userId);
    status.passkeyCount = (await auth.listPasskeys(session.userId)).length;
    return status;
  });

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  app.post<{ Body: { username: string; password: string } }>('/auth/bootstrap', {
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 1 },
          password: { type: 'string', minLength: 8 },
        },
      },
    },
  }, async (request, reply) => {
    if (await auth.hasAnyUser()) {
      return reply.status(409).send({
        error: 'Admin user already exists',
        code: 'ALREADY_BOOTSTRAPPED',
      });
    }

    const { id } = await auth.bootstrap(request.body.username, request.body.password);
    const session = await auth.createSession(id);
    setSessionCookie(reply, session.sessionId, session.expiresAt);
    return reply.status(201).send({ id, expiresAt: session.expiresAt });
  });

  // ── Login / logout ─────────────────────────────────────────────────────────

  app.post<{ Body: { username: string; password: string; totp?: string } }>('/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 1 },
          password: { type: 'string', minLength: 1 },
          totp: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const session = await auth.loginWithPassword(request.body.username, request.body.password, request.body.totp);
    setSessionCookie(reply, session.sessionId, session.expiresAt);
    return reply.send({ ok: true, expiresAt: session.expiresAt });
  });

  app.post('/auth/logout', async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (sessionId) await auth.deleteSession(sessionId);
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  // Password is checked before issuing a browser-bound, one-use login ticket.
  // No session is created until the independent WebAuthn assertion succeeds.
  const loginFlowCookie = 'og_login_flow';
  const flowCookieOptions = { ...cookieOptions, path: '/auth/login/passkey', maxAge: 300 };

  // Authenticate before schema parsing and bound password-verification work.
  // Use the configured public origin; forwarded/Host headers are untrusted.
  const accountOrigin = new URL(auth.origin).origin;
  const accountAttempts = new Map<string, { count: number; resetAt: number }>();
  async function accountWrite(request: FastifyRequest, reply: FastifyReply) {
    const session = await currentSession(request, reply);
    if (!session) return reply;
    if ((request.headers.origin !== undefined && request.headers.origin !== accountOrigin)
      || request.headers['sec-fetch-site'] === 'cross-site') {
      return reply.status(403).send({ code: 'INVALID_ORIGIN', error: '请从 owngate 页面修改账户。' });
    }
    const now = Date.now();
    for (const [id, attempt] of accountAttempts) if (attempt.resetAt <= now) accountAttempts.delete(id);
    const attempt = accountAttempts.get(session.userId) ?? { count: 0, resetAt: now + 60_000 };
    accountAttempts.set(session.userId, attempt);
    if (++attempt.count > 10) {
      reply.header('Retry-After', String(Math.ceil((attempt.resetAt - now) / 1000)));
      return reply.status(429).send({ code: 'ACCOUNT_RATE_LIMIT', error: '账户修改尝试过于频繁，请稍后再试。' });
    }
  }
  function finishAccountChange(reply: FastifyReply, result: { ok: true; changed: boolean; requiresLogin: boolean }) {
    if (result.requiresLogin) {
      clearSessionCookie(reply);
      reply.clearCookie(loginFlowCookie, { path: flowCookieOptions.path });
    }
    return result;
  }
  function accountFields(fields: readonly string[]) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      // Fastify normally coerces field types and strips additional properties.
      // Account mutations require the exact, explicitly supplied string fields.
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some((key) => !fields.includes(key))
        || fields.some((key) => typeof (body as Record<string, unknown>)[key] !== 'string')) {
        return reply.status(400).send({ code: 'BAD_REQUEST', error: '账户信息格式不正确。' });
      }
    };
  }
  const currentPasswordSchema = { type: 'string', minLength: 1, maxLength: 1024 };
  app.get('/auth/account', async (request, reply) => {
    const session = await currentSession(request, reply);
    if (!session) return reply;
    return auth.getAccount(session.userId, session.sessionId);
  });
  app.patch<{ Body: { username: string; current_password: string } }>('/auth/account', {
    onRequest: accountWrite,
    preValidation: accountFields(['username', 'current_password']),
    schema: { body: { type: 'object', additionalProperties: false, required: ['username', 'current_password'], properties: {
      username: { type: 'string', minLength: 1, maxLength: 128 }, current_password: currentPasswordSchema,
    } } },
  }, async (request, reply) => {
    const session = await currentSession(request, reply);
    if (!session) return reply;
    return finishAccountChange(reply, await auth.updateAccount(session.userId, session.sessionId, request.body.username, request.body.current_password));
  });
  app.post<{ Body: { current_password: string; new_password: string } }>('/auth/account/password', {
    onRequest: accountWrite,
    preValidation: accountFields(['current_password', 'new_password']),
    schema: { body: { type: 'object', additionalProperties: false, required: ['current_password', 'new_password'], properties: {
      current_password: currentPasswordSchema, new_password: { type: 'string', minLength: 8, maxLength: 1024 },
    } } },
  }, async (request, reply) => {
    const session = await currentSession(request, reply);
    if (!session) return reply;
    return finishAccountChange(reply, await auth.changeAccountPassword(session.userId, session.sessionId, request.body.current_password, request.body.new_password));
  });

  app.post<{ Body: { username: string; password: string } }>('/auth/login/passkey/begin', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: {
      username: { type: 'string', minLength: 1, maxLength: 128 }, password: { type: 'string', minLength: 1, maxLength: 1024 },
    } } },
  }, async (request, reply) => {
    const existing = request.cookies[loginFlowCookie];
    const binding = existing && /^[a-f0-9]{64}$/.test(existing) ? existing : randomBytes(32).toString('hex');
    const result = await auth.beginPasskeyLogin(request.body.username, request.body.password, binding);
    reply.setCookie(loginFlowCookie, binding, flowCookieOptions);
    return result;
  });
  app.post<{ Body: { ticket: string; response: AuthenticationResponseJSON } }>('/auth/login/passkey/finish', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['ticket', 'response'], properties: {
      ticket: { type: 'string', pattern: '^[a-f0-9]{64}$' }, response: { type: 'object' },
    } } },
  }, async (request, reply) => {
    const session = await auth.finishPasskeyLogin(request.body.ticket, request.cookies[loginFlowCookie] ?? '', request.body.response);
    reply.clearCookie(loginFlowCookie, { path: flowCookieOptions.path });
    if (!session) return reply.status(401).send({ code: 'PASSKEY_FAILED', error: '验证未通过或登录流程已过期，请重新开始。' });
    setSessionCookie(reply, session.sessionId, session.expiresAt);
    return { ok: true, expiresAt: session.expiresAt };
  });

  app.post<{ Body: { password: string } }>('/auth/mfa/setup', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['password'], properties: { password: { type: 'string', minLength: 1, maxLength: 1024 } } } },
  }, async (request, reply) => {
    const session = await currentSession(request, reply);
    if (!session) return reply;
    if (!await auth.proveInitialSetup(session.userId, session.sessionId, request.body.password)) return reply.status(401).send({ code: 'INVALID_CREDENTIALS', error: '密码不正确。' });
    return { ok: true, expires_in: 300 };
  });

  // ── Step-up (§7.2) ─────────────────────────────────────────────────────────

  app.post('/auth/step-up/passkey/begin', async (request, reply) => {
    const session = await currentSession(request, reply);
    if (!session) return reply;

    const passkeys = await auth.listPasskeys(session.userId);
    if (passkeys.length === 0) {
      return reply.status(409).send({
        error: 'No passkey registered',
        code: 'NO_PASSKEY',
      });
    }
    return reply.send(await auth.beginPasskeyAuthentication(session.userId, session.sessionId));
  });

  app.post<{ Body: { response: AuthenticationResponseJSON } }>('/auth/step-up/passkey/finish', async (request, reply) => {
    const session = await currentSession(request, reply);
    if (!session) return reply;

    const payload = bodyOf<{ response?: AuthenticationResponseJSON }>(request).response;
    if (!payload) {
      return reply.status(400).send({ error: 'Missing response', code: 'BAD_REQUEST' });
    }
    const result = await auth.finishPasskeyAuthentication(session.userId, payload, session.sessionId);
    if (!result.verified) {
      return reply.status(401).send({ error: 'Passkey verification failed', code: 'PASSKEY_FAILED' });
    }
    return reply.send({ ok: true, stepUp: true });
  });

  app.post<{ Body: { code: string; password: string } }>('/auth/step-up/totp', {
    schema: {
      body: {
        type: 'object',
        required: ['code', 'password'],
        additionalProperties: false,
        properties: { code: { type: 'string', maxLength: 32 }, password: { type: 'string', minLength: 1, maxLength: 1024 } },
      },
    },
  }, async (request, reply) => {
    const session = await currentSession(request, reply);
    if (!session) return reply;

    if (!(await auth.isTotpEnabled(session.userId))) {
      return reply.status(409).send({ error: 'TOTP not enabled', code: 'TOTP_NOT_ENABLED' });
    }
    if (!(await auth.stepUpWithTotp(session.userId, session.sessionId, request.body.password, request.body.code))) {
      return reply.status(401).send({ error: 'Password or TOTP code is invalid', code: 'INVALID_CREDENTIALS' });
    }
    return reply.send({ ok: true, stepUp: true });
  });

  // ── Passkeys ───────────────────────────────────────────────────────────────

  app.get('/auth/passkeys', async (request, reply) => {
    const session = await currentSession(request, reply);
    if (!session) return reply;
    return reply.send({ passkeys: await auth.listPasskeys(session.userId) });
  });

  app.post('/auth/passkeys/register/begin', async (request, reply) => {
    const session = await currentSession(request, reply);
    if (!session) return reply;

    const user = await deps.db.getAdminById(session.userId);
    if (!user) {
      return reply.status(401).send({ error: 'Unknown user', code: 'NO_SESSION' });
    }
    return reply.send(await auth.beginPasskeyRegistration(session.userId, user.username, session.sessionId));
  });

  app.post<{ Body: { response: RegistrationResponseJSON } }>('/auth/passkeys/register/finish', async (request, reply) => {
    const session = await currentSession(request, reply);
    if (!session) return reply;

    const payload = bodyOf<{ response?: RegistrationResponseJSON }>(request).response;
    if (!payload) {
      return reply.status(400).send({ error: 'Missing response', code: 'BAD_REQUEST' });
    }
    const result = await auth.finishPasskeyRegistration(session.userId, payload, session.sessionId);
    if (!result.verified) {
      return reply.status(400).send({ error: 'Passkey registration failed', code: 'PASSKEY_REGISTRATION_FAILED' });
    }
    return reply.status(201).send({ ok: true });
  });

  app.delete<{ Params: { id: string } }>('/auth/passkeys/:id', async (request, reply) => {
    const session = await currentSession(request, reply);
    if (!session) return reply;

    const existing = await auth.listPasskeys(session.userId);
    if (!existing.some((p) => p.id === request.params.id)) {
      return reply.status(404).send({ error: 'Passkey not found', code: 'NOT_FOUND' });
    }
    await auth.deletePasskey(session.userId, request.params.id, session.sessionId);
    return reply.send({ ok: true });
  });

  // ── TOTP ───────────────────────────────────────────────────────────────────

  app.post('/auth/totp/enroll', async (request, reply) => {
    const session = await currentSession(request, reply);
    if (!session) return reply;
    // A pending session-bound seed does not replace the active secret.
    const enrollment = await auth.enrollTotp(session.userId, session.sessionId);
    return reply.send({ ...enrollment, enabled: false });
  });

  app.post<{ Body: { code: string } }>('/auth/totp/confirm', {
    schema: {
      body: {
        type: 'object',
        required: ['code'],
        properties: { code: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const session = await currentSession(request, reply);
    if (!session) return reply;

    const ok = await auth.confirmTotp(session.userId, request.body.code, session.sessionId);
    if (!ok) {
      return reply.status(401).send({ error: 'Invalid TOTP code', code: 'TOTP_INVALID' });
    }
    return reply.send({ ok: true, totpEnabled: true });
  });

  app.post('/auth/totp/disable', async (request, reply) => {
    const session = await currentSession(request, reply);
    if (!session) return reply;

    await auth.disableTotp(session.userId, session.sessionId);
    return reply.send({ ok: true, totpEnabled: false });
  });
}
