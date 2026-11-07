// Session guard for the admin backend (design §8.4).
//
// createAdminGate() returns one onRequest hook that main.ts installs on the
// root instance, so every /admin/* route (present and future, in any route
// module) requires an admin session without per-handler code. Routes that hand
// out accounts or data additionally need a step-up verification from the last
// 15 minutes: they are listed in STEP_UP_ROUTES, or opt in with
// `config: { stepUp: true }` on the route.

import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { AuthService } from './service.js';

export const SESSION_COOKIE = 'og_session';

export interface AdminSession {
  sessionId: string;
  userId: string;
}

/** Cookie flags for og_session. `secure` only when the deployment is served over https. */
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
  // An accidentally inherited development flag cannot disable production auth.
  if (process.env['NODE_ENV'] === 'development' && process.env['DEV_SKIP_AUTH'] === '1') {
    return { sessionId: 'dev', userId: 'dev-user' };
  }

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

// ── Central admin gate ─────────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Route needs a recent step-up in addition to the admin session (§8.4). */
    stepUp?: boolean;
  }
}

/**
 * Routes that require step-up, as `METHOD path` with path parameters written
 * as `:param` (the parameter name does not matter for matching). §8.4 lists:
 * open the remote screen, import cookies, issue a client token, change grants.
 * The cookie-import route is listed ahead of its implementation so it is gated
 * the moment it is registered.
 */
export const STEP_UP_ROUTES: readonly string[] = [
  'POST /admin/clients',
  'POST /admin/grants',
  'POST /admin/screen/:connectionId/open',
  'POST /admin/connections/:connectionId/cookies',
];

/** Replace every `:name` segment with `:`, so `:id` and `:connectionId` compare equal. */
function normalizePattern(path: string): string {
  return path.replace(/:[^/]+/g, ':');
}

const STEP_UP_KEYS = new Set(
  STEP_UP_ROUTES.map((r) => {
    const [method = '', path = ''] = r.split(' ');
    return `${method.toUpperCase()} ${normalizePattern(path)}`;
  }),
);

/** True when the route (by registered pattern) is in STEP_UP_ROUTES. */
export function isStepUpRoute(method: string, routePattern: string): boolean {
  return STEP_UP_KEYS.has(`${method.toUpperCase()} ${normalizePattern(routePattern)}`);
}

/** Paths covered by the gate: `/admin` and everything below it. */
export function isAdminPath(path: string): boolean {
  return path === '/admin' || path.startsWith('/admin/');
}

/**
 * onRequest hook enforcing the admin session on every /admin/* request and
 * step-up on the routes that need it. It runs before body parsing and schema
 * validation, so an unauthenticated caller always gets 401, never a 400 that
 * describes the route's body.
 *
 * Unmatched /admin/* URLs are gated too, so a caller without a session cannot
 * tell which admin routes exist.
 */
export function createAdminGate(auth: AuthService): onRequestAsyncHookHandler {
  return async function adminGate(request, reply) {
    // routeOptions.url is the registered pattern; undefined when nothing matched.
    const pattern = request.routeOptions.url;
    const path = pattern ?? (request.raw.url ?? '').split('?')[0] ?? '';
    if (!isAdminPath(path)) return;

    const needsStepUp = pattern !== undefined &&
      (request.routeOptions.config.stepUp === true || isStepUpRoute(request.method, pattern));

    const session = needsStepUp
      ? await requireStepUp(request, reply, auth)
      : await requireAdminSession(request, reply, auth);
    if (session === null) return reply;
  };
}
