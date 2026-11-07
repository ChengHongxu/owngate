import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ScreencastSession, signRequest } from '@owngate/browser-runtime'
import { buildBrowserServer } from '../src/main.js'
import { FakeSessionManager, SECRET, until } from './helpers.js'

beforeAll(() => { process.env['BROWSER_RPC_SECRET'] = SECRET })

describe('authenticated screencast input', () => {
  it('declares the browser viewport separately from frame image contents', async () => {
    let sendFrame: Parameters<ScreencastSession['start']>[1] | undefined
    const start = vi.spyOn(ScreencastSession.prototype, 'start')
      .mockImplementation(async (_options, onFrame) => { sendFrame = onFrame })
    const capture = vi.spyOn(ScreencastSession.prototype, 'captureQrSnapshot').mockResolvedValue(null)
    const sessions = new FakeSessionManager()
    const { app } = await buildBrowserServer({ sessionManager: sessions })
    try {
      const { stream_token } = await sessions.startLogin('viewport-fixture', 'https://passport.bilibili.com/login', {
        successWhen: [{ type: 'cookie', name: 'SESSDATA', domain: '.bilibili.com' }],
      })
      const path = '/v1/screencast?token=' + stream_token
      const signed = signRequest('', SECRET, { method: 'GET', path })
      await app.ready()
      const socket = await app.injectWS(path, { headers: { 'x-og-sig': signed['X-Og-Sig'], 'x-og-ts': signed['X-Og-Ts'], 'x-og-nonce': signed['X-Og-Nonce'] } })
      const frames: unknown[] = []
      socket.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString()) as { type: string }
        if (message.type === 'frame') frames.push(message)
      })
      await until(() => sendFrame !== undefined)
      sendFrame!('complete-viewport-fixture', 100)
      sendFrame!('cropped-qr-fixture', 101)
      await until(() => frames.length === 2)
      expect(frames).toEqual([
        { type: 'frame', data: 'complete-viewport-fixture', ts: 100, width: 1280, height: 800 },
        { type: 'frame', data: 'cropped-qr-fixture', ts: 101, width: 1280, height: 800 },
      ])
      socket.close()
    } finally {
      start.mockRestore()
      capture.mockRestore()
      await sessions.closeAll()
      await app.close()
    }
  })

  it('clears a previously displayed QR when it disappears from the login page', async () => {
    let finishFirst: ((data: string) => void) | undefined
    const capture = vi.spyOn(ScreencastSession.prototype, 'captureQrSnapshot')
      .mockImplementationOnce(() => new Promise<string>((resolve) => { finishFirst = resolve }))
      .mockResolvedValue(null)
    const sessions = new FakeSessionManager()
    const { app } = await buildBrowserServer({ sessionManager: sessions })
    try {
      const { stream_token } = await sessions.startLogin('qr-fixture', 'https://passport.bilibili.com/login', {
        successWhen: [{ type: 'cookie', name: 'SESSDATA', domain: '.bilibili.com' }],
      })
      const path = '/v1/screencast?token=' + stream_token
      const signed = signRequest('', SECRET, { method: 'GET', path })
      await app.ready()
      const socket = await app.injectWS(path, { headers: { 'x-og-sig': signed['X-Og-Sig'], 'x-og-ts': signed['X-Og-Ts'], 'x-og-nonce': signed['X-Og-Nonce'] } })
      const messages: { type: string; data: string | null }[] = []
      socket.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString())))
      await until(() => finishFirst !== undefined)
      finishFirst!(Buffer.from('fixture-only-qr').toString('base64'))
      await until(() => messages.some((message) => message.type === 'qr' && message.data !== null))
      await until(() => messages.some((message) => message.type === 'qr' && message.data === null), 3_000)
      socket.close()
    } finally {
      capture.mockRestore()
      await sessions.closeAll()
      await app.close()
    }
  })

  it('routes allowed input to CDP and refuses arbitrary commands', async () => {
    const sessions = new FakeSessionManager()
    const { app } = await buildBrowserServer({ sessionManager: sessions })
    try {
      const { stream_token } = await sessions.startLogin('input-fixture', 'https://passport.bilibili.com/login', {
        successWhen: [{ type: 'cookie', name: 'SESSDATA', domain: '.bilibili.com' }],
      })
      const path = '/v1/screencast?token=' + stream_token
      const signed = signRequest('', SECRET, { method: 'GET', path })
      await app.ready()
      const socket = await app.injectWS(path, { headers: { 'x-og-sig': signed['X-Og-Sig'], 'x-og-ts': signed['X-Og-Ts'], 'x-og-nonce': signed['X-Og-Nonce'] } })
      const page = sessions.world.launched[0]!.ctx.page
      await until(() => page.cdpCommands.includes('Page.startScreencast'))
      socket.send(JSON.stringify({ type: 'input', event: { type: 'text', text: '中文 fixture' } }))
      socket.send(JSON.stringify({ type: 'input', event: { type: 'mouse', event: 'mousePressed', x: 10, y: 20 } }))
      socket.send(JSON.stringify({ type: 'input', event: { type: 'Page.navigate', url: 'http://127.0.0.1/' } }))
      await until(() => page.cdpCommands.includes('Input.dispatchMouseEvent'))
      expect(page.cdpEvents).toContainEqual({ method: 'Input.insertText', params: { text: '中文 fixture' } })
      expect(page.cdpCommands).not.toContain('Page.navigate')
      socket.close()
    } finally {
      await sessions.closeAll()
      await app.close()
    }
  })
})
