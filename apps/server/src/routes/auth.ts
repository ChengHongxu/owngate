// Admin authentication routes — /auth/*
// Design doc §8.2 (recovery), §8.9 (audit), §7.2 (step-up), D8 (password + passkey + TOTP).
//
// Self-contained: registers @fastify/cookie itself so main.ts only has to call
// registerAuthRoutes(app, { auth, db }). The plugin breaks encapsulation (fastify-plugin),
// so cookies are parsed for routes registered after this call as well.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import type { DbClient } from '@webridge/db';
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
    const user = await auth.verifyPassword(request.body.username, request.body.password);
    if (!user) {
      return reply.status(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
    }

    if (await auth.isTotpEnabled(user.id)) {
      const code = request.body.totp;
      if (code === undefined || code.length === 0) {
        return reply.status(401).send({ error: 'TOTP required', code: 'TOTP_REQUIRED' });
      }
      if (!(await auth.verifyTotp(user.id, code))) {
        return reply.status(401).send({ error: 'Invalid TOTP code', code: 'TOTP_INVALID' });
      }
    }

    const session = await auth.createSession(user.id);
    setSessionCookie(reply, session.sessionId, session.expiresAt);
    return reply.send({ ok: true, expiresAt: session.expiresAt });
  });

  app.post('/auth/logout', async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (sessionId) await auth.deleteSession(sessionId);
    clearSessionCookie(reply);
    return reply.send({ ok: true });
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
    return reply.send(await auth.beginPasskeyAuthentication(session.userId));
  });

  app.post<{ Body: { response: AuthenticationResponseJSON } }>('/auth/step-up/passkey/finish', async (request, reply) => {
    const session = await currentSession(request, reply);
    if (!session) return reply;

    const payload = bodyOf<{ response?: AuthenticationResponseJSON }>(request).response;
    if (!payload) {
      return reply.status(400).send({ error: 'Missing response', code: 'BAD_REQUEST' });
    }
    const result = await auth.finishPasskeyAuthentication(session.userId, payload);
    if (!result.verified) {
      return reply.status(401).send({ error: 'Passkey verification failed', code: 'PASSKEY_FAILED' });
    }
    await auth.markStepUp(session.sessionId);
    return reply.send({ ok: true, stepUp: true });
  });

  app.post<{ Body: { code: string } }>('/auth/step-up/totp', {
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

    if (!(await auth.isTotpEnabled(session.userId))) {
      return reply.status(409).send({ error: 'TOTP not enabled', code: 'TOTP_NOT_ENABLED' });
    }
    if (!(await auth.verifyTotp(session.userId, request.body.code))) {
      return reply.status(401).send({ error: 'Invalid TOTP code', code: 'TOTP_INVALID' });
    }
    await auth.markStepUp(session.sessionId);
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
    return reply.send(await auth.beginPasskeyRegistration(session.userId, user.username));
  });

  app.post<{ Body: { response: RegistrationResponseJSON } }>('/auth/passkeys/register/finish', async (request, reply) => {
    const session = await currentSession(request, reply);
    if (!session) return reply;

    const payload = bodyOf<{ response?: RegistrationResponseJSON }>(request).response;
    if (!payload) {
      return reply.status(400).send({ error: 'Missing response', code: 'BAD_REQUEST' });
    }
    const result = await auth.finishPasskeyRegistration(session.userId, payload);
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
    await auth.deletePasskey(session.userId, request.params.id);
    return reply.send({ ok: true });
  });

  // ── TOTP ───────────────────────────────────────────────────────────────────

  app.post('/auth/totp/enroll', async (request, reply) => {
    const session = await currentSession(request, reply);
    if (!session) return reply;
    // Re-enrolling replaces the stored secret. When TOTP is already enabled that is
    // the documented "seed lost -> rebind" path (§8.2), which requires a fresh
    // passkey verification first; otherwise an abandoned flow would lock the admin out.
    if (await auth.isTotpEnabled(session.userId)) {
      if (!(await auth.hasStepUp(session.sessionId))) {
        return reply.status(403).send({
          error: 'Verify with a passkey before rebinding TOTP',
          code: 'STEP_UP_REQUIRED',
        });
      }
    }
    // Returns the secret so the user can scan/add it; not enabled until confirm.
    const enrollment = await auth.enrollTotp(session.userId);
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

    const ok = await auth.confirmTotp(session.userId, request.body.code);
    if (!ok) {
      return reply.status(401).send({ error: 'Invalid TOTP code', code: 'TOTP_INVALID' });
    }
    return reply.send({ ok: true, totpEnabled: true });
  });

  app.post<{ Body: { code: string } }>('/auth/totp/disable', {
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

    const ok = await auth.disableTotp(session.userId, request.body.code);
    if (!ok) {
      return reply.status(401).send({ error: 'Invalid TOTP code', code: 'TOTP_INVALID' });
    }
    return reply.send({ ok: true, totpEnabled: false });
  });
}
