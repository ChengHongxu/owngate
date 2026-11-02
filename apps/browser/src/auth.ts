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
      // Health check has no body to sign — the only unprotected route
      const pathname = request.url.split('?')[0]
      if (request.method === 'GET' && pathname === '/v1/health') return

      const sig = request.headers['x-wr-sig']
      const ts = request.headers['x-wr-ts']

      if (typeof sig !== 'string' || typeof ts !== 'string') {
        return reply.status(401).send(UNAUTH)
      }

      if (!verifyRequest(request.rawBody, sig, ts, secret)) {
        return reply.status(401).send(UNAUTH)
      }
    })
  }

  return fp(plugin)
}
