// HMAC-SHA256 request authentication plugin (design doc §13.1)

import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { CLOCK_SKEW_MS, verifyRequest } from '@owngate/browser-runtime'
import { workerError } from './errors.js'

declare module 'fastify' {
  interface FastifyRequest {
    rawBody: string
  }
}

const UNAUTH = workerError(
  'UNAUTHENTICATED',
  'invalid signature or timestamp',
  'check BROWSER_RPC_SECRET and clock sync',
)

export function makeHmacPlugin(secret: string) {
  const plugin: FastifyPluginAsync = async (app) => {
    const acceptedNonces = new Map<string, number>()
    app.decorateRequest('rawBody', '')

    // Capture raw body string before parsing so HMAC can be verified
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      const bodyStr = typeof body === 'string' ? body : (body as Buffer).toString('utf8')
      req.rawBody = bodyStr
      let parsed: unknown
      try {
        parsed = JSON.parse(bodyStr)
      } catch {
        // statusCode 400: the app error handler turns it into INVALID_PARAMS.
        done(Object.assign(new Error('request body is not valid JSON'), { statusCode: 400 }), undefined)
        return
      }
      done(null, parsed)
    })

    app.addHook('preHandler', async (request, reply) => {
      // GET /v1/health stays the only unprotected route: the container
      // healthcheck cannot sign, and it reveals nothing beyond liveness.
      const pathname = request.url.split('?')[0]
      if (request.method === 'GET' && pathname === '/v1/health') return

      const sig = request.headers['x-og-sig']
      const ts = request.headers['x-og-ts']
      const nonce = request.headers['x-og-nonce']

      if (typeof sig !== 'string' || typeof ts !== 'string' || typeof nonce !== 'string') {
        return reply.status(401).send(UNAUTH)
      }

      const body = request.method === 'GET' ? '' : request.rawBody
      if (!verifyRequest(body, sig, ts, secret, { method: request.method, path: request.url }, nonce)) {
        return reply.status(401).send(UNAUTH)
      }
      const now = Date.now()
      for (const [seen, expiresAt] of acceptedNonces) {
        if (expiresAt < now) acceptedNonces.delete(seen)
      }
      // No await between the lookup and insert: simultaneous identical
      // requests cannot both pass this one-use check.
      if (acceptedNonces.has(nonce)) return reply.status(401).send(UNAUTH)
      acceptedNonces.set(nonce, Number(ts) + CLOCK_SKEW_MS)
    })
  }

  return fp(plugin)
}
