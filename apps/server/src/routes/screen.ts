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
  /** Forwards to the browser worker: POST /v1/login/start */
  startLogin: (connectionId: string, url: string, qrSelector?: string) => Promise<{ stream_token: string }>;
  stopLogin: (connectionId: string) => Promise<{ ok: boolean }>;
  /** Append to audit_log */
  audit: (entry: { action: string; target?: string; detail?: unknown; client_id?: string }) => void;
  /** Opens the HMAC-signed upstream socket: GET /v1/screencast?token=... */
  openUpstream: (streamToken: string) => WebSocket;
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

const UNAUTHORIZED = { code: 'UNAUTHORIZED' };
const STEP_UP_REQUIRED = {
  code: 'STEP_UP_REQUIRED',
  what_happened: '远程画面等于完全控制该账号，需要二次验证',
  next_step: '在后台完成 Passkey 或 TOTP 验证',
};

const WS_OPEN = 1;

// ── Routes ───────────────────────────────────────────────────────────────

export async function registerScreenRoutes(app: FastifyInstance, deps: ScreenDeps): Promise<void> {
  // @fastify/websocket must be registered before the upgrade route is added.
  // It is a direct dependency of this package; register it here idempotently so
  // main.ts only needs registerScreenRoutes().
  if (!app.hasPlugin('@fastify/websocket')) {
    const { default: fastifyWebsocket } = await import('@fastify/websocket');
    await app.register(fastifyWebsocket);
  }

  // ── POST /admin/screen/:connectionId/open ──────────────────────────────
  app.post<{
    Params: { connectionId: string };
    Body: { url: string; qr_selector?: string };
  }>('/admin/screen/:connectionId/open', {
    schema: {
      body: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string' },
          qr_selector: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = await deps.getAdminUserId(request);
    if (userId === null) return reply.status(401).send(UNAUTHORIZED);

    if (!(await deps.hasStepUp(request))) {
      return reply.status(403).send(STEP_UP_REQUIRED);
    }

    const { connectionId } = request.params;
    const { url, qr_selector: qrSelector } = request.body;

    let streamToken: string;
    try {
      const started = await deps.startLogin(connectionId, url, qrSelector);
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
      detail: { url, qr_selector: qrSelector ?? null, user_id: userId },
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
        if (userId === null || userId !== entry.userId) {
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
          upstream = deps.openUpstream(entry.streamToken);
        } catch (e) {
          app.log.error({ err: (e as Error).message }, 'screencast upstream failed');
          client.close(1011, 'upstream unavailable');
          return;
        }

        let closed = false;
        const closeBoth = (code: number, reason: string): void => {
          if (closed) return;
          closed = true;
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

        upstream.addEventListener('close', () => {
          closeBoth(1011, 'upstream closed');
        });

        // admin browser → browser worker: only input events, and only after
        // the upgrade is open. Mouse/keyboard injection itself is a later step
        // (see the /input route below).
        client.on('message', (raw: Buffer) => {
          if (upstream.readyState !== WS_OPEN) return;
          const text = raw.toString();
          try {
            const msg: unknown = JSON.parse(text);
            if (
              typeof msg === 'object' && msg !== null &&
              (msg as { type?: unknown }).type === 'input'
            ) {
              upstream.send(text);
            }
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
      if (userId === null) return reply.status(401).send(UNAUTHORIZED);

      if (!(await deps.hasStepUp(request))) {
        return reply.status(403).send(STEP_UP_REQUIRED);
      }

      const { connectionId } = request.params;
      const result = await deps.stopLogin(connectionId);

      deps.audit({
        action: 'screen.stop',
        target: connectionId,
        detail: { user_id: userId },
      });

      return { ok: result.ok };
    },
  );

  // ── POST /admin/screen/:connectionId/input ─────────────────────────────
  // TODO(§4.4.3): forward to the live screencast socket as CDP input —
  //   mouse → Input.dispatchMouseEvent
  //   key   → Input.dispatchKeyEvent
  //   text  → Input.insertText (bypasses the IME, which is why CDP was chosen
  //           over VNC — see §4.4.4)
  // Until that lands this must fail loudly rather than accept input that goes
  // nowhere.
  app.post<{
    Params: { connectionId: string };
    Body: { type: 'mouse' | 'key' | 'text' } & Record<string, unknown>;
  }>('/admin/screen/:connectionId/input', {
    schema: {
      body: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', enum: ['mouse', 'key', 'text'] },
        },
        additionalProperties: true,
      },
    },
  }, async (request, reply) => {
    const userId = await deps.getAdminUserId(request);
    if (userId === null) return reply.status(401).send(UNAUTHORIZED);

    if (!(await deps.hasStepUp(request))) {
      return reply.status(403).send(STEP_UP_REQUIRED);
    }

    return reply.status(501).send({
      code: 'NOT_IMPLEMENTED',
      next_step: '输入转发在 M1 后续提交中实现',
    });
  });
}
