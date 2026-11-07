// Systematic check of the admin gate (§8.4). Routes are collected with the
// onRoute hook from the real buildServer(), so a route added later without
// the gate fails here instead of shipping open.
//
// /ws/screen/* is not under /admin: it is gated by a one-time ticket (screen.ts).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, HTTPMethods, RouteOptions } from 'fastify';
import { buildServer } from '../src/main.js';
import { STEP_UP_ROUTES, isAdminPath, isStepUpRoute } from '../src/auth/guard.js';
import { loginAdmin, tempDbPath } from './helpers/admin.js';
import type { AdminSession } from './helpers/admin.js';

interface AdminRoute {
  method: HTTPMethods;
  url: string;
}

let app: FastifyInstance;
let cleanupDb: () => void;
const routes: AdminRoute[] = [];

function concrete(url: string): string {
  // Any value works: the gate answers before the handler looks it up.
  return url.replace(/:[^/]+/g, 'x');
}

function label(r: AdminRoute): string {
  return `${r.method} ${r.url}`;
}

beforeAll(async () => {
  const db = tempDbPath();
  cleanupDb = db.cleanup;
  const server = await buildServer({
    dbPath: db.path,
    onRoute: (route: RouteOptions) => {
      if (!isAdminPath(route.url)) return;
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) routes.push({ method, url: route.url });
    },
  });
  app = server.app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  cleanupDb();
});

describe('admin gate — every /admin route', () => {
  it('found the admin routes (sanity check on the enumeration)', () => {
    const keys = routes.map(label);
    expect(keys).toContain('POST /admin/clients');
    expect(keys).toContain('POST /admin/grants');
    expect(keys).toContain('GET /admin/connections');
    expect(keys).toContain('POST /admin/screen/:connectionId/open');
    expect(routes.length).toBeGreaterThan(10);
  });

  it('removed routes are gone', () => {
    const keys = routes.map(label);
    expect(keys).not.toContain('POST /admin/login/start');
    expect(keys).not.toContain('POST /admin/login/:id/stop');
  });

  it('answers 401 NO_SESSION to every route without a cookie', async () => {
    const open: string[] = [];
    for (const r of routes) {
      const res = await app.inject({ method: r.method, url: concrete(r.url), payload: {} });
      if (res.statusCode !== 401) {
        open.push(`${label(r)} → ${res.statusCode}`);
        continue;
      }
      // HEAD responses carry no body.
      if (r.method !== 'HEAD') expect(res.json(), label(r)).toMatchObject({ code: 'NO_SESSION' });
    }
    expect(open).toEqual([]);
  });

  it('answers 401 SESSION_EXPIRED to every route with an unknown session cookie', async () => {
    const open: string[] = [];
    for (const r of routes) {
      const res = await app.inject({
        method: r.method,
        url: concrete(r.url),
        headers: { cookie: 'og_session=not-a-real-session' },
        payload: {},
      });
      if (res.statusCode !== 401) open.push(`${label(r)} → ${res.statusCode}`);
      else if (r.method !== 'HEAD') expect(res.json(), label(r)).toMatchObject({ code: 'SESSION_EXPIRED' });
    }
    expect(open).toEqual([]);
  });

  it('gates unmatched /admin URLs too, so routes cannot be discovered', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/does-not-exist' });
    expect(res.statusCode).toBe(401);
  });
});

describe('admin gate — step-up routes', () => {
  let admin: AdminSession;

  beforeAll(async () => {
    admin = await loginAdmin(app);
  });

  it('the §8.4 sensitive operations are all marked step-up', () => {
    expect(isStepUpRoute('POST', '/admin/clients')).toBe(true);
    expect(isStepUpRoute('POST', '/admin/grants')).toBe(true);
    expect(isStepUpRoute('POST', '/admin/screen/:connectionId/open')).toBe(true);
    // Parameter names do not matter for matching.
    expect(isStepUpRoute('POST', '/admin/connections/:id/cookies')).toBe(true);
    expect(isStepUpRoute('GET', '/admin/connections')).toBe(false);
  });

  it('answers 403 STEP_UP_REQUIRED to every step-up route with a session but no step-up', async () => {
    const stepUpRoutes = routes.filter((r) => isStepUpRoute(r.method, r.url));
    // Every registered entry of STEP_UP_ROUTES is exercised (the cookie route
    // may not be registered yet).
    expect(stepUpRoutes.length).toBeGreaterThanOrEqual(STEP_UP_ROUTES.length - 1);
    for (const r of stepUpRoutes) {
      const res = await app.inject({
        method: r.method,
        url: concrete(r.url),
        headers: admin.headers,
        payload: {},
      });
      expect(res.statusCode, label(r)).toBe(403);
      expect(res.json(), label(r)).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    }
  });

  it('lets a plain session through on routes without step-up', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/connections', headers: admin.headers });
    expect(res.statusCode).toBe(200);
  });

  it('a route opting in with config.stepUp is gated as well', async () => {
    // Needs its own server: routes cannot be added once `app` is ready.
    const db = tempDbPath();
    const other = await buildServer({ dbPath: db.path });
    try {
      other.app.post('/admin/__stepup_flag', { config: { stepUp: true } }, async () => ({ ok: true }));
      await other.app.ready();
      const otherAdmin = await loginAdmin(other.app);
      const res = await other.app.inject({ method: 'POST', url: '/admin/__stepup_flag', headers: otherAdmin.headers });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    } finally {
      await other.app.close();
      db.cleanup();
    }
  });
});
