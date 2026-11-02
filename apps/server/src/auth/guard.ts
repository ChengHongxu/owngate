// Session guard shared by admin-facing route modules.
// Not applied to existing routes yet — main.ts wiring decides which routes require it.

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService } from './service.js';

export const SESSION_COOKIE = 'wr_session';

export interface AdminSession {
  sessionId: string;
  userId: string;
}

/** Cookie flags for wr_session. `secure` only when the deployment is served over https. */
export function sessionCookieOptions(origin: string): {
  httpOnly: boolean;
  sameSite: 'strict';
  secure: boolean;
  path: string;
} {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: origin.startsWith('https'),
    path: '/',
  };
}

/**
 * Resolve the admin session for a request.
 * Returns null and sends 401 when the request is unauthenticated.
 *
 * Usage in a route module:
 *   const session = await requireAdminSession(request, reply, deps.auth);
 *   if (!session) return reply;
 */
export async function requireAdminSession(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthService,
): Promise<AdminSession | null> {
  const sessionId = request.cookies[SESSION_COOKIE];
  if (!sessionId) {
    await reply.status(401).send({ error: 'Not authenticated', code: 'NO_SESSION' });
    return null;
  }

  const session = await auth.getSession(sessionId);
  if (!session) {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    await reply.status(401).send({ error: 'Session expired', code: 'SESSION_EXPIRED' });
    return null;
  }

  return { sessionId, userId: session.userId };
}

/**
 * Like requireAdminSession, but additionally demands a recent step-up
 * verification (§7.2: sensitive operations need passkey / password + TOTP).
 */
export async function requireStepUp(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthService,
): Promise<AdminSession | null> {
  const session = await requireAdminSession(request, reply, auth);
  if (!session) return null;
  if (!(await auth.hasStepUp(session.sessionId))) {
    await reply.status(403).send({ error: 'Step-up verification required', code: 'STEP_UP_REQUIRED' });
    return null;
  }
  return session;
}
