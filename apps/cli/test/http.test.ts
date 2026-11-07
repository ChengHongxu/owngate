import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiCall, ApiTimeoutError, DEFAULT_TIMEOUT_MS } from '../src/http.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('API request timeouts', () => {
  it.each<{ configured?: string; explicit?: number; expected: number }>([
    { expected: DEFAULT_TIMEOUT_MS },
    { configured: '456', expected: 456 },
    { configured: 'invalid', expected: DEFAULT_TIMEOUT_MS },
    { configured: '0', expected: DEFAULT_TIMEOUT_MS },
    { configured: '-5', expected: DEFAULT_TIMEOUT_MS },
    { configured: 'Infinity', expected: DEFAULT_TIMEOUT_MS },
    { configured: '123', explicit: 789, expected: 789 },
  ])('uses environment=$configured and explicit=$explicit to select $expected ms', async ({ configured, explicit, expected }) => {
    vi.stubEnv('OWNGATE_TIMEOUT_MS', configured)
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    await apiCall('/api/connections', 'GET', undefined, {
      config: { server: 'https://fixture.invalid', token: 'fixture-token' },
      ...(explicit !== undefined ? { timeoutMs: explicit } : {}),
    })
    expect(timeout).toHaveBeenCalledWith(expected)
  })

  it('does not follow redirects while attaching the configured client credential', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    await apiCall('/api/connections', 'GET', undefined, { config: { server: 'https://fixture.invalid', token: 'fixture-token' } })
    expect(fetcher).toHaveBeenCalledWith('https://fixture.invalid/api/connections', expect.objectContaining({
      redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer fixture-token' }),
    }))
  })

  it('bounds streamed responses and cancels the body when the configured limit is exceeded', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"large":"')); controller.enqueue(new Uint8Array(100)); },
      cancel,
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    await expect(apiCall('/api/connections', 'GET', undefined, {
      config: { server: 'https://fixture.invalid', token: 'fixture-token' }, maxResponseBytes: 20,
    })).rejects.toThrow('Cannot reach')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('combines caller cancellation with the request deadline', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.signal?.aborted).toBe(true)
      throw new DOMException('Cancelled', 'AbortError')
    }))
    await expect(apiCall('/api/connections', 'GET', undefined, {
      config: { server: 'https://fixture.invalid', token: 'fixture-token' }, signal: controller.signal,
    })).rejects.toBeInstanceOf(ApiTimeoutError)
  })
})
