// Tests for the remote-screen forwarding routes (design §4.4.3 / §4.4.5).
//
// The WebSocket upgrade itself is verified manually later (nginx + real browser
// worker); these tests cover the HTTP-level auth gates and the one-time ticket
// lifecycle, which is where the security boundary actually lives.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  registerScreenRoutes,
  __consumeTicket,
  __resetTickets,
} from '../src/routes/screen.js';
import type { ScreenDeps } from '../src/routes/screen.js';

interface AuditEntry {
  action: string;
  target?: string;
  detail?: unknown;
  client_id?: string;
}

function buildDeps(overrides: Partial<ScreenDeps> = {}) {
  const audits: AuditEntry[] = [];
  const deps: ScreenDeps = {
    getAdminUserId: async (_request: FastifyRequest) => 'user-1',
    hasStepUp: async (_request: FastifyRequest) => true,
    startLogin: async (_connectionId: string, _url: string, _qrSelector?: string) => ({
      stream_token: 'stream-token-abc',
    }),
    stopLogin: async (_connectionId: string) => ({ ok: true }),
    audit: (entry: AuditEntry) => {
      audits.push(entry);
    },
    browserRpcUrl: 'http://browser:4000',
    ...overrides,
  };
  return { deps, audits };
}

async function buildApp(overrides: Partial<ScreenDeps> = {}) {
  const { deps, audits } = buildDeps(overrides);
  const app = Fastify({ logger: false });
  await registerScreenRoutes(app, deps);
  await app.ready();
  return { app, audits };
}

function openRequest(app: FastifyInstance, connectionId = 'conn-1') {
  return app.inject({
    method: 'POST',
    url: `/admin/screen/${connectionId}/open`,
    payload: { url: 'https://passport.bilibili.com/login', qr_selector: '#qr img' },
  });
}

describe('screen routes', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    __resetTickets();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.useRealTimers();
  });

  it('POST open returns 401 without an admin session', async () => {
    const built = await buildApp({ getAdminUserId: async () => null });
    app = built.app;

    const res = await openRequest(app);

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'UNAUTHORIZED' });
    // No upstream call, no ticket, no audit trail for an unauthorised attempt.
    expect(built.audits).toHaveLength(0);
  });

  it('POST open returns 403 when the session has not passed step-up', async () => {
    const built = await buildApp({ hasStepUp: async () => false });
    app = built.app;

    const res = await openRequest(app);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      code: 'STEP_UP_REQUIRED',
      what_happened: '远程画面等于完全控制该账号，需要二次验证',
      next_step: '在后台完成 Passkey 或 TOTP 验证',
    });
    expect(built.audits).toHaveLength(0);
  });

  it('POST open returns ticket and ws_path when session and step-up both pass', async () => {
    const startLogin = vi.fn(async () => ({ stream_token: 'stream-token-abc' }));
    const built = await buildApp({ startLogin });
    app = built.app;

    const res = await openRequest(app, 'conn-42');

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ticket: string; ws_path: string };
    expect(body.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(body.ws_path).toBe(`/ws/screen/conn-42?ticket=${body.ticket}`);
    expect(startLogin).toHaveBeenCalledWith(
      'conn-42',
      'https://passport.bilibili.com/login',
      '#qr img',
    );
    expect(built.audits).toContainEqual(
      expect.objectContaining({ action: 'screen.open', target: 'conn-42' }),
    );

    // The ticket resolves to the upstream stream token issued by the worker.
    const entry = __consumeTicket(body.ticket);
    expect(entry).toMatchObject({
      connectionId: 'conn-42',
      streamToken: 'stream-token-abc',
      userId: 'user-1',
    });
  });

  it('a ticket can be consumed only once', async () => {
    const built = await buildApp();
    app = built.app;

    const res = await openRequest(app);
    const { ticket } = res.json() as { ticket: string };

    expect(__consumeTicket(ticket)).toBeDefined();
    expect(__consumeTicket(ticket)).toBeUndefined();
  });

  it('rejects an expired ticket', async () => {
    const built = await buildApp();
    app = built.app;

    const res = await openRequest(app);
    const { ticket } = res.json() as { ticket: string };

    // Tickets live 60 s (design §4.4.5 one-time ticket, §4.4.3 short window).
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);

    expect(__consumeTicket(ticket)).toBeUndefined();
  });

  it('POST stop requires session and step-up, then calls stopLogin and audits', async () => {
    const stopLogin = vi.fn(async () => ({ ok: true }));
    const built = await buildApp({ stopLogin });
    app = built.app;

    const res = await app.inject({
      method: 'POST',
      url: '/admin/screen/conn-7/stop',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(stopLogin).toHaveBeenCalledWith('conn-7');
    expect(built.audits).toContainEqual(
      expect.objectContaining({ action: 'screen.stop', target: 'conn-7' }),
    );
  });

  it('POST input returns 501 rather than silently dropping input', async () => {
    const built = await buildApp();
    app = built.app;

    const res = await app.inject({
      method: 'POST',
      url: '/admin/screen/conn-1/input',
      payload: { type: 'mouse', x: 10, y: 20 },
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({
      code: 'NOT_IMPLEMENTED',
      next_step: '输入转发在 M1 后续提交中实现',
    });
  });
});
