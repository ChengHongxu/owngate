import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserContext } from 'playwright'
import { BrowserDiagnostics } from '../src/diagnostics.js'
import { classifyError, DeadlineExceededError, withDeadline } from '../src/errors.js'
import { captureSocial } from '../src/social/capture.js'

afterEach(() => { vi.useRealTimers() })

describe('social capture deadline diagnostics', () => {
  it('keeps the deadline cause when closing the page immediately rejects navigation, and still cleans up', async () => {
    vi.useFakeTimers()
    let rejectNavigation: ((reason: Error) => void) | undefined
    let navigationStarted!: () => void
    const started = new Promise<void>(resolve => { navigationStarted = resolve })
    const locator = {
      first() { return this },
      isVisible: async () => false,
      innerText: async () => '',
    }
    const page = {
      url: () => 'about:blank',
      locator: () => locator,
      on: vi.fn(),
      off: vi.fn(),
      goto: vi.fn(() => new Promise<never>((_resolve, reject) => {
        rejectNavigation = reject
        navigationStarted()
      })),
      close: vi.fn(() => {
        // Reject in the abort listener itself, before withDeadline rejects its
        // expired promise. This exposes the former diagnostic finalizer race.
        rejectNavigation?.(new Error('Target closed'))
        return Promise.resolve()
      }),
    }
    const context = { pages: () => [], newPage: async () => page } as unknown as BrowserContext
    const diagnostics = new BrowserDiagnostics()
    let signal: AbortSignal | undefined
    let capture: ReturnType<typeof captureSocial> | undefined
    const result = (async () => {
      try {
        await withDeadline(100, currentSignal => {
          signal = currentSignal
          capture = captureSocial(context, 'bilibili', 'history.list', { limit: 1 }, 100, currentSignal, { maxScrolls: 0 }, diagnostics)
          return capture
        })
        throw new Error('Expected the navigation to reach its deadline')
      } catch (error) {
        const code = classifyError(error, 'BROWSER_UNAVAILABLE')
        diagnostics.interrupt(code)
        return { error, code, steps: diagnostics.finish() }
      }
    })()

    await started
    const removeAbortListener = vi.spyOn(signal!, 'removeEventListener')
    await vi.advanceTimersByTimeAsync(100)
    const output = await result
    await expect(capture).rejects.toBeInstanceOf(DeadlineExceededError)

    expect(output.error).toBeInstanceOf(DeadlineExceededError)
    expect(output.code).toBe('UPSTREAM_TIMEOUT')
    expect(output.steps).toEqual([
      expect.objectContaining({ id: 'browser.auth', status: 'success' }),
      expect.objectContaining({ id: 'browser.navigate', status: 'error', code: 'UPSTREAM_TIMEOUT' }),
      expect.objectContaining({ id: 'browser.capture', status: 'error', code: 'UPSTREAM_TIMEOUT' }),
    ])
    expect(output.steps.some(step => step.id === 'browser.parse')).toBe(false)
    expect(output.steps.some(step => step.code === 'PARSE_FAILED')).toBe(false)
    expect(page.off).toHaveBeenCalledWith('response', page.on.mock.calls[0]?.[1])
    expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(page.close).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
