import { describe, expect, it } from 'vitest'
import { buildBrowserServer } from '../src/main.js'
import { FakeSessionManager, SECRET, until } from './helpers.js'

describe('real server RPC client and browser worker', () => {
  it.each([
    { name: 'omitted', deadline: undefined, expected: 30_000 },
    { name: 'explicit', deadline: 1750, expected: 1750 },
  ])('uses the $name deadline for successful check and probe requests', async ({ deadline, expected }) => {
    process.env['BROWSER_RPC_SECRET'] = SECRET
    const sessions = new FakeSessionManager()
    const deadlines: number[] = []
    const { app } = await buildBrowserServer({
      sessionManager: sessions,
      exec: async (_context, _capability, _params, deadlineMs, _signal, connector) => {
        deadlines.push(deadlineMs)
        return { status: 'ok', data: { connector, uid: 42 } }
      },
    })
    const moduleUrl = new URL('../../server/src/browser-client.ts', import.meta.url).href
    const { createBrowserClient } = await import(/* @vite-ignore */ moduleUrl)
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (address === null || typeof address === 'string') throw new Error('expected a local TCP address')
    const client = createBrowserClient({ baseUrl: `http://127.0.0.1:${address.port}`, secret: SECRET })
    const requestDeadline = deadline === undefined ? {} : { deadline_ms: deadline }
    try {
      await expect(client.check({
        connection_id: 'deadline-fixture', connector_id: 'bilibili', capability: 'account.profile',
        params: {}, exec_id: 'deadline-exec-fixture', ...requestDeadline,
      })).resolves.toEqual({ status: 'ok', data: { connector: 'bilibili', uid: 42 } })
      await sessions.world.launched[0]!.ctx.addCookies([{ name: 'SESSDATA', value: 'fixture', domain: '.bilibili.com' }])
      await expect(client.probe({
        connection_id: 'deadline-fixture', connector_id: 'bilibili', login_url: 'https://passport.bilibili.com/login',
        success_when: [{ type: 'cookie', name: 'SESSDATA', domain: '.bilibili.com' }],
        whoami: 'account.profile', ...requestDeadline,
      })).resolves.toEqual({ status: 'supported', account: { connector: 'bilibili', uid: 42 } })
      expect(deadlines[0]).toBe(expected)
      expect(deadlines[1]).toBeGreaterThan(0)
      expect(deadlines[1]).toBeLessThanOrEqual(expected)
    } finally {
      await sessions.closeAll()
      await app.close()
    }
  })

  it('agrees on signed POST, GET and WebSocket requests', async () => {
    process.env['BROWSER_RPC_SECRET'] = SECRET
    const sessions = new FakeSessionManager()
    const { app } = await buildBrowserServer({
      sessionManager: sessions,
      exec: async (_context, _capability, _params, _deadline, _signal, connector) => ({ status: 'ok', data: { connector, uid: 42 } }),
    })
    // Import the actual server client source, not a second signer written in
    // the test. A URL keeps the worker package's TS build rooted in its src.
    const moduleUrl = new URL('../../server/src/browser-client.ts', import.meta.url).href
    const { createBrowserClient } = await import(/* @vite-ignore */ moduleUrl)
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (address === null || typeof address === 'string') throw new Error('expected a local TCP address')
    const client = createBrowserClient({ baseUrl: `http://127.0.0.1:${address.port}`, secret: SECRET })
    let socket: WebSocket | undefined
    try {
      await expect(client.openSession('client-fixture')).resolves.toEqual({ session_id: 'client-fixture' })
      await expect(client.loginStatus('client-fixture')).resolves.toMatchObject({ status: 'idle' })
      const result = await client.check({ connection_id: 'client-fixture', connector_id: 'bilibili', capability: 'account.profile', params: {}, exec_id: 'client-exec-fixture', deadline_ms: 1000 })
      expect(result).toEqual({ status: 'ok', data: { connector: 'bilibili', uid: 42 } })
      const login = await client.startLogin({ connection_id: 'client-fixture', url: 'https://passport.bilibili.com/login', success_when: [{ type: 'cookie', name: 'SESSDATA', domain: '.bilibili.com' }] })
      const stream = client.openScreencast(login.stream_token) as WebSocket
      socket = stream
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('signed WebSocket did not open')), 2000)
        stream.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
        stream.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('signed WebSocket rejected')) }, { once: true })
      })
      await until(() => sessions.world.launched[0]!.ctx.page.cdpCommands.includes('Page.startScreencast'))
      stream.send(JSON.stringify({ type: 'input', event: { type: 'text', text: 'fixture' } }))
      await until(() => sessions.world.launched[0]!.ctx.page.cdpCommands.includes('Input.insertText'))
      await client.stopLogin('client-fixture')
      await expect(client.loginStatus('client-fixture')).resolves.toMatchObject({ status: 'idle' })
    } finally {
      socket?.close()
      await sessions.closeAll()
      await app.close()
    }
  })
})
