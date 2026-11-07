// Remote screen forwarding — design doc §4.4.3 (CDP remote login) and §4.4.5
// (remote screen security boundary).
//
// The browser worker exposes the screencast as a WebSocket, but §4.4.5 is
// explicit: "远程画面只能经 server 转发，MCP 和 CLI 令牌都不行". So the stream
// terminates here, behind an admin session + step-up check + a one-time ticket,
// and is re-emitted to the admin browser. Neither MCP nor CLI credentials can
// reach this path.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────────────

export interface ScreenDeps {
  /** Verifies an admin session cookie and returns the userId, or null. */
  getAdminUserId: (request: FastifyRequest) => Promise<string | null>;
  /** True when the session has passed step-up auth (design §7.2). */
  hasStepUp: (request: FastifyRequest) => Promise<boolean>;
  /** BrowserClient instance for calling the worker. */
  browserClient: {
    startLogin: (req: {
      connection_id: string;
      url: string;
      success_when: unknown[];
      qr_selector?: string;
      deadline_ms?: number;
    }) => Promise<{ stream_token: string }>;
    stopLogin: (connectionId: string) => Promise<{ ok: boolean }>;
    loginStatus: (connectionId: string) => Promise<{ status: string; reason?: string; since: string }>;
    openScreencast: (streamToken: string) => WebSocket;
  };
  /** Connection map for looking up connectors. */
  connectionMap: Map<string, { id: string; connector_id: string }>;
  /** Connector registry for login settings. */
  getLogin: (connectorId: string) => { url: string; successWhen: unknown[]; qrSelector?: string } | undefined;
  /** Append to audit_log */
  audit: (entry: { action: string; target?: string; detail?: unknown; client_id?: string }) => void;
  /** Invalidate observations after a new login signal, without assuming auth. */
  onLoginCompleted?: (connectionId: string, since: string) => Promise<void>;
}

export interface TicketEntry {
  connectionId: string;
  streamToken: string;
  userId: string;
  expiresAt: number;
}

// ── One-time tickets ─────────────────────────────────────────────────────
//
// A ticket is issued by POST open and redeemed exactly once by the WebSocket
// upgrade. It lives 60 s — long enough for the admin page to open the socket,
// short enough that a leaked ticket (browser history, proxy log) is worthless.

const TICKET_TTL_MS = 60_000;
const tickets = new Map<string, TicketEntry>();

/**
 * Look up a ticket and remove it in the same step. Returns undefined when the
 * ticket is unknown, already redeemed, or expired. Exported for tests.
 */
export function __consumeTicket(ticket: string): TicketEntry | undefined {
  const entry = tickets.get(ticket);
  if (entry === undefined) return undefined;
  tickets.delete(ticket);
  if (Date.now() >= entry.expiresAt) return undefined;
  return entry;
}

/** Clear the ticket store. Exported for tests. */
export function __resetTickets(): void {
  tickets.clear();
}

// Admin session codes (NO_SESSION / SESSION_EXPIRED / STEP_UP_REQUIRED) are
// not §6.1 ErrorCodes; same 401 body as the admin gate in auth/guard.ts.
const NO_SESSION = { error: 'Not authenticated', code: 'NO_SESSION' };
const STEP_UP_REQUIRED = {
  code: 'STEP_UP_REQUIRED',
  what_happened: '远程画面等于完全控制该账号，需要二次验证',
  next_step: '在后台完成 Passkey 或 TOTP 验证',
};

const WS_OPEN = 1;

function validInput(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (JSON.stringify(input).length > 16_384) return false;
  if (input['type'] === 'reload') return true;
  if (input['type'] === 'text') return typeof input['text'] === 'string' && input['text'].length <= 4096;
  if (input['type'] === 'key') {
    return (input['event'] === 'keyDown' || input['event'] === 'keyUp') &&
      typeof input['key'] === 'string' && input['key'].length <= 64 &&
      typeof input['code'] === 'string' && input['code'].length <= 64;
  }
  if (input['type'] !== 'mouse' && input['type'] !== 'wheel') return false;
  if (typeof input['x'] !== 'number' || !Number.isFinite(input['x']) || input['x'] < 0 || input['x'] > 20_000 ||
    typeof input['y'] !== 'number' || !Number.isFinite(input['y']) || input['y'] < 0 || input['y'] > 20_000) return false;
  if (input['type'] === 'mouse') return input['event'] === 'mousePressed' || input['event'] === 'mouseReleased' || input['event'] === 'mouseMoved';
  return typeof input['deltaX'] === 'number' && Number.isFinite(input['deltaX']) && Math.abs(input['deltaX']) <= 10_000 &&
    typeof input['deltaY'] === 'number' && Number.isFinite(input['deltaY']) && Math.abs(input['deltaY']) <= 10_000;
}

// ── Routes ───────────────────────────────────────────────────────────────

export async function registerScreenRoutes(app: FastifyInstance, deps: ScreenDeps): Promise<void> {
  const activeScreens = new Map<string, Set<{ userId: string; upstream: WebSocket }>>();
  const completedLogins = new Map<string, string>();
  // @fastify/websocket must be registered before the upgrade route is added.
  // It is a direct dependency of this package; register it here idempotently so
  // main.ts only needs registerScreenRoutes().
  if (!app.hasPlugin('@fastify/websocket')) {
    const { default: fastifyWebsocket } = await import('@fastify/websocket');
    await app.register(fastifyWebsocket);
  }

  // ── POST /admin/screen/:connectionId/open ──────────────────────────────
  // §4.4.3: url comes from the manifest login.url; no longer accepts url in body.
  app.post<{
    Params: { connectionId: string };
    Body: Record<string, unknown>;
  }>('/admin/screen/:connectionId/open', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
  }, async (request, reply) => {
    const userId = await deps.getAdminUserId(request);
    if (userId === null) return reply.status(401).send(NO_SESSION);

    if (!(await deps.hasStepUp(request))) {
      return reply.status(403).send(STEP_UP_REQUIRED);
    }

    const { connectionId } = request.params;
    const conn = deps.connectionMap.get(connectionId);
    if (!conn) {
      return reply.status(404).send({
        code: 'CONNECTION_NOT_FOUND',
        what_happened: '连接不存在',
        next_step: '检查连接 ID 是否正确',
      });
    }

    const login = deps.getLogin(conn.connector_id);
    if (!login) {
      return reply.status(400).send({
        code: 'CAPABILITY_UNSUPPORTED',
        what_happened: '该连接的清单中没有 login 段，不支持远程登录',
        next_step: '此连接只能通过其他方式（如令牌）认证',
      });
    }

    let streamToken: string;
    try {
      const started = await deps.browserClient.startLogin({
        connection_id: connectionId,
        url: login.url,
        success_when: login.successWhen as unknown as unknown[],
        ...(login.qrSelector !== undefined ? { qr_selector: login.qrSelector } : {}),
      });
      streamToken = started.stream_token;
    } catch (e) {
      return reply.status(502).send({
        code: 'UPSTREAM_ERROR',
        what_happened: (e as Error).message,
        next_step: 'check the browser worker and the connection state',
        retryable: true,
      });
    }

    const ticket = randomBytes(32).toString('hex');
    tickets.set(ticket, {
      connectionId,
      streamToken,
      userId,
      expiresAt: Date.now() + TICKET_TTL_MS,
    });

    deps.audit({
      action: 'screen.open',
      target: connectionId,
      detail: { url: login.url, qr_selector: login.qrSelector ?? null, user_id: userId },
    });

    return { ticket, ws_path: '/ws/screen/' + connectionId + '?ticket=' + ticket };
  });

  // ── GET /ws/screen/:connectionId (WebSocket) ───────────────────────────
  app.get<{ Params: { connectionId: string }; Querystring: { ticket?: string } }>(
    '/ws/screen/:connectionId',
    { websocket: true },
    (client, request) => {
      const { connectionId } = request.params;
      const ticket = request.query.ticket;

      const entry = typeof ticket === 'string' ? __consumeTicket(ticket) : undefined;
      if (entry === undefined || entry.connectionId !== connectionId) {
        client.close(1008, 'invalid or expired ticket');
        return;
      }

      // Re-check the session at upgrade time: the ticket proves the open call
      // was authorised 60 s ago, but the session may have been revoked since.
      void (async () => {
        const userId = await deps.getAdminUserId(request);
        if (userId === null || userId !== entry.userId || !(await deps.hasStepUp(request))) {
          client.close(1008, 'unauthorized');
          return;
        }

        deps.audit({
          action: 'screen.ws.open',
          target: connectionId,
          detail: { user_id: userId },
        });

        // `client` is the @fastify/websocket server socket; `upstream` is the
        // signed client socket to the browser worker.
        let upstream: WebSocket;
        try {
          upstream = deps.browserClient.openScreencast(entry.streamToken);
        } catch (e) {
          app.log.error({ err: (e as Error).message }, 'screencast upstream failed');
          client.close(1011, 'upstream unavailable');
          return;
        }

        let closed = false;
        const screen = { userId, upstream };
        const screens = activeScreens.get(connectionId) ?? new Set();
        screens.add(screen);
        activeScreens.set(connectionId, screens);
        const closeBoth = (code: number, reason: string): void => {
          if (closed) return;
          closed = true;
          screens.delete(screen);
          if (screens.size === 0) activeScreens.delete(connectionId);
          try {
            upstream.close();
          } catch {
            // Already closed — nothing to do.
          }
          if (client.readyState === WS_OPEN) client.close(code, reason);
        };

        // browser worker → admin browser: frames and QR snapshots pass through
        // unchanged (JSON text frames).
        upstream.addEventListener('message', (event) => {
          if (client.readyState !== WS_OPEN) return;
          const data: unknown = event.data;
          if (typeof data !== 'string') return; // worker only sends JSON text
          client.send(data);
        });

        upstream.addEventListener('error', () => {
          closeBoth(1011, 'upstream error');
        });

        upstream.addEventListener('close', (event) => {
          closeBoth(event.code === 1000 ? 1000 : 1011, 'upstream closed');
        });

        // Preserve command order while rechecking the current session and
        // step-up. Closing/revoking a session also stops an already open view
        // from injecting input. Password/text contents never enter the audit.
        let inputQueue = Promise.resolve();
        let pendingInputs = 0;
        client.on('message', (raw: Buffer) => {
          if (upstream.readyState !== WS_OPEN || raw.length > 16_384 || pendingInputs >= 100) return;
          const text = raw.toString();
          try {
            const msg = JSON.parse(text) as { type?: unknown; event?: unknown };
            if (msg?.type !== 'input' || !validInput(msg.event)) return;
            pendingInputs++;
            inputQueue = inputQueue.then(async () => {
              if (closed) return;
              if ((await deps.getAdminUserId(request)) !== userId || !(await deps.hasStepUp(request))) {
                closeBoth(1008, 'session or verification expired');
                return;
              }
              if (upstream.readyState === WS_OPEN) upstream.send(JSON.stringify({ type: 'input', event: msg.event }));
            }).catch(() => closeBoth(1011, 'input unavailable')).finally(() => { pendingInputs--; });
          } catch {
            // Ignore non-JSON client frames.
          }
        });

        client.on('close', () => {
          // Deliberately do NOT call deps.stopLogin() here: closing the screen
          // (tab switch, refresh, network blip) must not tear down the login
          // session — the browser keeps rendering and the login state stays in
          // the profile. stopLogin is triggered only by the explicit
          // POST /admin/screen/:id/stop route (design §4.4.3 step 4).
          closeBoth(1000, 'client closed');
        });

        client.on('error', () => {
          closeBoth(1011, 'client error');
        });
      })().catch((e: Error) => {
        app.log.error({ err: e.message }, 'screen ws handler failed');
        if (client.readyState === WS_OPEN) client.close(1011, 'internal error');
      });
    },
  );

  // ── POST /admin/screen/:connectionId/stop ──────────────────────────────
  app.post<{ Params: { connectionId: string } }>(
    '/admin/screen/:connectionId/stop',
    async (request, reply) => {
      const userId = await deps.getAdminUserId(request);
      if (userId === null) return reply.status(401).send(NO_SESSION);

      if (!(await deps.hasStepUp(request))) {
        return reply.status(403).send(STEP_UP_REQUIRED);
      }

      const { connectionId } = request.params;
      const result = await deps.browserClient.stopLogin(connectionId);

      deps.audit({
        action: 'screen.stop',
        target: connectionId,
        detail: { user_id: userId },
      });

      return { ok: result.ok };
    },
  );

  // ── GET /admin/screen/:connectionId/status ──────────────────────────────
  // Requires admin session (会话即可), not step-up, so the login page can poll.
  app.get<{ Params: { connectionId: string } }>(
    '/admin/screen/:connectionId/status',
    async (request, reply) => {
      const userId = await deps.getAdminUserId(request);
      if (userId === null) return reply.status(401).send(NO_SESSION);

      const { connectionId } = request.params;
      try {
        const status = await deps.browserClient.loginStatus(connectionId);
        if (status.status === 'success' && completedLogins.get(connectionId) !== status.since) {
          await deps.onLoginCompleted?.(connectionId, status.since);
          completedLogins.set(connectionId, status.since);
        }
        return status;
      } catch (e) {
        return reply.status(502).send({
          code: 'UPSTREAM_ERROR',
          what_happened: (e as Error).message,
        });
      }
    },
  );

  // HTTP fallback uses an already authorised live screen, so it cannot open
  // a second, un-ticketed remote-control path to the browser worker.
  app.post<{
    Params: { connectionId: string };
    Body: Record<string, unknown>;
  }>('/admin/screen/:connectionId/input', {
    schema: {
      body: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', enum: ['mouse', 'key', 'text', 'wheel', 'reload'] },
        },
        additionalProperties: true,
      },
    },
  }, async (request, reply) => {
    const userId = await deps.getAdminUserId(request);
    if (userId === null) return reply.status(401).send(NO_SESSION);

    if (!(await deps.hasStepUp(request))) {
      return reply.status(403).send(STEP_UP_REQUIRED);
    }

    if (!validInput(request.body)) return reply.status(400).send({ code: 'INVALID_PARAMS', what_happened: '输入事件格式不正确' });
    const screen = Array.from(activeScreens.get(request.params.connectionId) ?? [])
      .find((candidate) => candidate.userId === userId && candidate.upstream.readyState === WS_OPEN);
    if (!screen) return reply.status(409).send({ code: 'SCREEN_NOT_OPEN', what_happened: '请先打开该连接的远程登录画面' });
    screen.upstream.send(JSON.stringify({ type: 'input', event: request.body }));
    return { ok: true };
  });
}
