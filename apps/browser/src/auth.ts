// HMAC-SHA256 request authentication plugin (design doc §13.1)

import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { verifyRequest } from '@webridge/browser-runtime'

declare module 'fastify' {
  interface FastifyRequest {
    rawBody: string
  }
}

const UNAUTH = {
  code: 'UNAUTHORIZED',
  what_happened: 'invalid signature or timestamp',
  next_step: 'check BROWSER_RPC_SECRET and clock sync',
  retryable: false,
} as const

export function makeHmacPlugin(secret: string) {
  const plugin: FastifyPluginAsync = async (app) => {
    app.decorateRequest('rawBody', '')

    // Capture raw body string before parsing so HMAC can be verified
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      const bodyStr = typeof body === 'string' ? body : (body as Buffer).toString('utf8')
      req.rawBody = bodyStr
      let parsed: unknown
      try {
        parsed = JSON.parse(bodyStr)
      } catch {
        done(new Error('Invalid JSON body'), undefined)
        return
      }
      done(null, parsed)
    })

    app.addHook('preHandler', async (request, reply) => {
      // GET /v1/health stays the only unprotected route: the container
      // healthcheck cannot sign, and it reveals nothing beyond liveness.
      const pathname = request.url.split('?')[0]
      if (request.method === 'GET' && pathname === '/v1/health') return

      const sig = request.headers['x-wr-sig']
      const ts = request.headers['x-wr-ts']

      if (typeof sig !== 'string' || typeof ts !== 'string') {
        return reply.status(401).send(UNAUTH)
      }

      // What a GET signs: it has no body, so it signs its path + query exactly
      // as sent (e.g. "/v1/login/status?connection_id=abc").
      //
      // GET /v1/login/status is not whitelisted like health. Its data is
      // read-only and holds no secrets, but it does tell the caller which
      // connection ids exist and whether each one is logged in. Only the
      // server should learn that, so it must be signed.
      //
      // Why not sign an empty string: the HMAC covers the payload only, not
      // X-Wr-Ts (see hmac.ts). HMAC('') would be the same for every GET, so
      // one captured signature would act as a permanent key for every GET
      // route and every connection_id. Signing the URL ties the signature to
      // one route and one connection_id. Replay of that exact URL is still
      // possible, the same weakness every POST body already has.
      const payload = request.method === 'GET' ? request.url : request.rawBody

      if (!verifyRequest(payload, sig, ts, secret)) {
        return reply.status(401).send(UNAUTH)
      }
    })
  }

  return fp(plugin)
}
