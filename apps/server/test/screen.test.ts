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
  const connectionMap = new Map([
    ['conn-1', { id: 'conn-1', connector_id: 'bilibili' }],
    ['conn-42', { id: 'conn-42', connector_id: 'bilibili' }],
  ]);
  const deps: ScreenDeps = {
    getAdminUserId: async (_request: FastifyRequest) => 'user-1',
    hasStepUp: async (_request: FastifyRequest) => true,
    browserClient: {
      startLogin: async (_req) => ({ stream_token: 'stream-token-abc' }),
      stopLogin: async (_connectionId: string) => ({ ok: true }),
      loginStatus: async (_connectionId: string) => ({
        status: 'idle',
        since: new Date().toISOString(),
      }),
      openScreencast: (_streamToken: string): WebSocket => {
        throw new Error('upgrade is not exercised by these HTTP-level tests');
      },
    },
    connectionMap,
    getLogin: (_connectorId: string) => ({
      url: 'https://passport.bilibili.com/login',
      successWhen: [{ type: 'cookie', name: 'SESSDATA', domain: '.bilibili.com' }],
      qrSelector: '#qr img',
    }),
    audit: (entry: AuditEntry) => {
      audits.push(entry);
    },
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
    payload: {},
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
    expect(res.json()).toEqual({ error: 'Not authenticated', code: 'NO_SESSION' });
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
    const built = await buildApp({
      browserClient: {
        startLogin,
        stopLogin: async () => ({ ok: true }),
        loginStatus: async () => ({ status: 'idle', since: new Date().toISOString() }),
        openScreencast: () => {
          throw new Error('not exercised');
        },
      },
    });
    app = built.app;

    const res = await openRequest(app, 'conn-42');

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ticket: string; ws_path: string };
    expect(body.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(body.ws_path).toBe(`/ws/screen/conn-42?ticket=${body.ticket}`);
    expect(startLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        connection_id: 'conn-42',
        url: 'https://passport.bilibili.com/login',
        qr_selector: '#qr img',
      }),
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
    const built = await buildApp({
      browserClient: {
        startLogin: async () => ({ stream_token: 'abc' }),
        stopLogin,
        loginStatus: async () => ({ status: 'idle', since: new Date().toISOString() }),
        openScreencast: () => {
          throw new Error('not exercised');
        },
      },
    });
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

  it('POST input requires an already ticketed active screen', async () => {
    const built = await buildApp();
    app = built.app;

    const res = await app.inject({
      method: 'POST',
      url: '/admin/screen/conn-1/input',
      payload: { type: 'mouse', event: 'mousePressed', x: 10, y: 20 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('SCREEN_NOT_OPEN');
  });

  it('records each completed login signal once, including a new login after a previously settled one', async () => {
    const onLoginCompleted = vi.fn(async (_connectionId: string, _since: string) => undefined);
    const { deps } = buildDeps();
    let since = '2026-11-07T00:00:00.000Z';
    const built = await buildApp({ onLoginCompleted, browserClient: {
      ...deps.browserClient, loginStatus: async () => ({ status: 'success', since }),
    } });
    app = built.app;
    for (let index = 0; index < 3; index++) {
      expect((await app.inject({ method: 'GET', url: '/admin/screen/conn-1/status' })).statusCode).toBe(200);
    }
    expect(onLoginCompleted).toHaveBeenCalledTimes(1);
    expect(onLoginCompleted).toHaveBeenCalledWith('conn-1', since);
    since = '2026-11-07T01:00:00.000Z';
    await app.inject({ method: 'GET', url: '/admin/screen/conn-1/status' });
    expect(onLoginCompleted).toHaveBeenCalledTimes(2);
  });

  it('POST input rejects invalid commands and requires step-up', async () => {
    const built = await buildApp();
    app = built.app;
    const res = await app.inject({ method: 'POST', url: '/admin/screen/conn-1/input', payload: { type: 'mouse', event: 'Page.navigate', x: 10, y: 20 } });
    expect(res.statusCode).toBe(400);
    const locked = await buildApp({ hasStepUp: async () => false });
    try {
      const denied = await locked.app.inject({ method: 'POST', url: '/admin/screen/conn-1/input', payload: { type: 'text', text: 'fixture' } });
      expect(denied.statusCode).toBe(403);
    } finally { await locked.app.close(); }
  });

  it('forwards ticketed input and stops accepting it when the admin session is revoked', async () => {
    class Upstream extends EventTarget {
      readyState = 1;
      sent: string[] = [];
      send(text: string) { this.sent.push(text); }
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.dispatchEvent(Object.assign(new Event('close'), { code: 1000 }));
      }
    }
    const upstream = new Upstream();
    let authorised = true;
    const { deps } = buildDeps();
    const built = await buildApp({
      getAdminUserId: async () => authorised ? 'user-1' : null,
      browserClient: { ...deps.browserClient, openScreencast: () => upstream as unknown as WebSocket },
    });
    app = built.app;
    const opened = await openRequest(app);
    const socket = await app.injectWS(opened.json().ws_path);
    try {
      await vi.waitFor(() => expect(built.audits.some((entry) => entry.action === 'screen.ws.open')).toBe(true));
      socket.send(JSON.stringify({ type: 'input', event: { type: 'Page.navigate', url: 'http://127.0.0.1/' } }));
      socket.send(JSON.stringify({ type: 'input', event: { type: 'text', text: 'private fixture input' } }));
      await vi.waitFor(() => expect(upstream.sent).toHaveLength(1));
      expect(JSON.parse(upstream.sent[0]!)).toEqual({ type: 'input', event: { type: 'text', text: 'private fixture input' } });
      const fallback = await app.inject({ method: 'POST', url: '/admin/screen/conn-1/input', payload: { type: 'key', event: 'keyDown', key: 'Enter', code: 'Enter' } });
      expect(fallback.statusCode).toBe(200);
      expect(upstream.sent).toHaveLength(2);
      expect(JSON.stringify(built.audits)).not.toContain('private fixture input');
      authorised = false;
      const closed = new Promise<number>((resolve) => socket.once('close', resolve));
      socket.send(JSON.stringify({ type: 'input', event: { type: 'text', text: 'after revocation' } }));
      expect(await closed).toBe(1008);
      expect(upstream.sent).toHaveLength(2);
    } finally { socket.close(); }
  });
});
