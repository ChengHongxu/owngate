import { describe, expect, it, vi } from 'vitest'
import type { Page } from 'playwright'
import { parseScreenInput } from '../src/input.js'
import { ScreencastSession } from '../src/screencast.js'

describe('remote screen input boundary', () => {
  it('accepts bounded text, mouse and keyboard commands', () => {
    expect(parseScreenInput({ type: 'text', text: '中文 fixture' })).toEqual({ type: 'text', text: '中文 fixture' })
    expect(parseScreenInput({ type: 'mouse', event: 'mousePressed', x: 10, y: 20 })).toMatchObject({ type: 'mouse', x: 10, y: 20 })
    expect(parseScreenInput({ type: 'key', event: 'keyDown', key: 'Enter', code: 'Enter', keyCode: 13 })).toMatchObject({ type: 'key', keyCode: 13 })
  })

  it.each([
    { type: 'Page.navigate', url: 'http://127.0.0.1' },
    { type: 'text', text: 'x'.repeat(4097) },
    { type: 'mouse', event: 'mousePressed', x: -1, y: 1 },
    { type: 'mouse', event: 'mousePressed', x: Number.NaN, y: 1 },
    { type: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 10001 },
    { type: 'key', event: 'keyDown', key: 'a', code: 'KeyA', modifiers: 16 },
  ])('rejects unsupported or unbounded commands %#', (input) => {
    expect(parseScreenInput(input)).toBeUndefined()
  })

  it('uses the same CDP session for input, stream stop and detach', async () => {
    const send = vi.fn(async () => ({}))
    const detach = vi.fn(async () => undefined)
    const newCDPSession = vi.fn(async () => ({ send, on: vi.fn(), detach }))
    const page = { context: () => ({ newCDPSession }) } as unknown as Page
    const session = new ScreencastSession(page)
    await session.start({}, () => undefined)
    await session.input(parseScreenInput({ type: 'text', text: 'fixture' })!)
    await session.input(parseScreenInput({ type: 'key', event: 'keyDown', key: 'Enter', code: 'Enter', keyCode: 13 })!)
    expect(send).toHaveBeenCalledWith('Input.insertText', { text: 'fixture' })
    expect(send).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({ windowsVirtualKeyCode: 13 }))
    await session.stop()
    expect(send).toHaveBeenCalledWith('Page.stopScreencast')
    expect(newCDPSession).toHaveBeenCalledOnce()
    expect(detach).toHaveBeenCalledOnce()
    await expect(session.input({ type: 'text', text: 'after close' })).rejects.toThrow('not active')
  })
})
