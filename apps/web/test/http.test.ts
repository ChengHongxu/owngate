import { describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  STEP_UP_CANCELLED,
  createRequester,
  createStepUpGate,
  describeAuthError,
  isSessionLost,
  isStepUpRequired,
  shouldRetryQuery,
  toApiError,
  withStepUp,
} from '../src/lib/http'

const stepUpError = () => new ApiError(403, 'STEP_UP_REQUIRED', 'Step-up verification required')

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('withStepUp', () => {
  it('passes through a successful call without prompting', async () => {
    const stepUp = vi.fn(async () => true)
    await expect(withStepUp(async () => 42, stepUp)).resolves.toBe(42)
    expect(stepUp).not.toHaveBeenCalled()
  })

  it('prompts once on STEP_UP_REQUIRED and retries the original call once', async () => {
    let calls = 0
    const run = vi.fn(async () => {
      calls++
      if (calls === 1) throw stepUpError()
      return 'ok'
    })
    const stepUp = vi.fn(async () => true)
    await expect(withStepUp(run, stepUp)).resolves.toBe('ok')
    expect(run).toHaveBeenCalledTimes(2)
    expect(stepUp).toHaveBeenCalledTimes(1)
  })

  it('does not loop when the retry still demands step-up', async () => {
    const run = vi.fn(async () => {
      throw stepUpError()
    })
    const stepUp = vi.fn(async () => true)
    await expect(withStepUp(run, stepUp)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' })
    expect(run).toHaveBeenCalledTimes(2)
    expect(stepUp).toHaveBeenCalledTimes(1)
  })

  it('throws STEP_UP_CANCELLED and skips the retry when the user cancels', async () => {
    const run = vi.fn(async () => {
      throw stepUpError()
    })
    await expect(withStepUp(run, async () => false)).rejects.toMatchObject({
      status: 403,
      code: STEP_UP_CANCELLED,
    })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('rethrows other errors untouched', async () => {
    const err = new ApiError(403, 'PERMISSION_DENIED', 'nope')
    const stepUp = vi.fn(async () => true)
    await expect(withStepUp(async () => Promise.reject(err), stepUp)).rejects.toBe(err)
    expect(stepUp).not.toHaveBeenCalled()
  })
})

describe('createStepUpGate', () => {
  it('returns false when no dialog is mounted', async () => {
    const gate = createStepUpGate()
    await expect(gate.request()).resolves.toBe(false)
  })

  it('shares one prompt between concurrent requests', async () => {
    const gate = createStepUpGate()
    let resolve: (ok: boolean) => void = () => {}
    const prompt = vi.fn(() => new Promise<boolean>((r) => (resolve = r)))
    gate.setPrompt(prompt)
    const a = gate.request()
    const b = gate.request()
    resolve(true)
    await expect(Promise.all([a, b])).resolves.toEqual([true, true])
    expect(prompt).toHaveBeenCalledTimes(1)
    // 结束后再次请求会重新弹框
    const c = gate.request()
    resolve(false)
    await expect(c).resolves.toBe(false)
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it('treats a throwing prompt as cancelled', async () => {
    const gate = createStepUpGate()
    gate.setPrompt(() => Promise.reject(new Error('boom')))
    await expect(gate.request()).resolves.toBe(false)
  })
})

describe('error classification', () => {
  it('treats NO_SESSION / SESSION_EXPIRED / unknown 401 as session lost', () => {
    expect(isSessionLost(new ApiError(401, 'NO_SESSION', ''))).toBe(true)
    expect(isSessionLost(new ApiError(401, 'SESSION_EXPIRED', ''))).toBe(true)
    expect(isSessionLost(new ApiError(401, undefined, ''))).toBe(true)
  })

  it('does not treat credential failures as session lost', () => {
    for (const code of ['INVALID_CREDENTIALS', 'TOTP_REQUIRED', 'TOTP_INVALID', 'PASSKEY_FAILED']) {
      expect(isSessionLost(new ApiError(401, code, ''))).toBe(false)
    }
    expect(isSessionLost(new ApiError(403, 'STEP_UP_REQUIRED', ''))).toBe(false)
    expect(isSessionLost(new Error('x'))).toBe(false)
  })

  it('recognises STEP_UP_REQUIRED only on 403', () => {
    expect(isStepUpRequired(stepUpError())).toBe(true)
    expect(isStepUpRequired(new ApiError(401, 'STEP_UP_REQUIRED', ''))).toBe(false)
  })

  it('parses both error body shapes', () => {
    const a = toApiError(401, 'Unauthorized', { error: 'Session expired', code: 'SESSION_EXPIRED' }, '')
    expect(a).toMatchObject({ status: 401, code: 'SESSION_EXPIRED', message: 'Session expired' })
    const b = toApiError(
      403,
      'Forbidden',
      { code: 'STEP_UP_REQUIRED', what_happened: '需要二次验证', next_step: '去验证' },
      '',
    )
    expect(b).toMatchObject({ code: 'STEP_UP_REQUIRED', message: '需要二次验证', nextStep: '去验证' })
    const c = toApiError(502, 'Bad Gateway', 'upstream down', 'upstream down')
    expect(c).toMatchObject({ status: 502, code: undefined, message: 'upstream down' })
  })

  it('describes known auth codes in Chinese and falls back to the message', () => {
    expect(describeAuthError(new ApiError(401, 'TOTP_INVALID', 'Invalid TOTP code'))).toBe('验证码不正确或已过期。')
    expect(describeAuthError(new ApiError(500, 'X', 'server says'))).toBe('server says')
  })

  it('does not retry queries on 401/403', () => {
    expect(shouldRetryQuery(0, new ApiError(401, 'NO_SESSION', ''))).toBe(false)
    expect(shouldRetryQuery(0, stepUpError())).toBe(false)
    expect(shouldRetryQuery(0, new ApiError(502, undefined, ''))).toBe(true)
    expect(shouldRetryQuery(1, new ApiError(502, undefined, ''))).toBe(false)
  })
})

describe('createRequester', () => {
  it('retries the original request once after step-up succeeds', async () => {
    const responses = [jsonResponse(403, { code: 'STEP_UP_REQUIRED' }), jsonResponse(200, { ticket: 't' })]
    const fetch = vi.fn(async () => responses.shift()!)
    const stepUp = vi.fn(async () => true)
    const onSessionLost = vi.fn()
    const call = createRequester({ fetch, stepUp, onSessionLost })

    await expect(call('/admin/screen/c1/open', { method: 'POST', body: {} })).resolves.toEqual({ ticket: 't' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(stepUp).toHaveBeenCalledTimes(1)
    const [path, init] = fetch.mock.calls[1] as unknown as [string, RequestInit]
    expect(path).toBe('/admin/screen/c1/open')
    expect(init).toMatchObject({ method: 'POST', body: '{}', credentials: 'include' })
    expect(onSessionLost).not.toHaveBeenCalled()
  })

  it('does not prompt when stepUp is disabled for the call', async () => {
    const fetch = vi.fn(async () => jsonResponse(403, { code: 'STEP_UP_REQUIRED' }))
    const stepUp = vi.fn(async () => true)
    const call = createRequester({ fetch, stepUp, onSessionLost: () => {} })
    await expect(call('/auth/step-up/totp', { body: { code: '1' }, stepUp: false })).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    })
    expect(stepUp).not.toHaveBeenCalled()
  })

  it('reports session loss on 401 unless disabled', async () => {
    const fetch = vi.fn(async () => jsonResponse(401, { error: 'Not authenticated', code: 'NO_SESSION' }))
    const onSessionLost = vi.fn()
    const call = createRequester({ fetch, stepUp: async () => true, onSessionLost })

    await expect(call('/admin/connections')).rejects.toMatchObject({ code: 'NO_SESSION' })
    expect(onSessionLost).toHaveBeenCalledTimes(1)

    await expect(call('/auth/login', { body: {}, sessionLost: false })).rejects.toBeInstanceOf(ApiError)
    expect(onSessionLost).toHaveBeenCalledTimes(1)
  })

  it('does not report session loss for client-token /api/* routes', async () => {
    const fetch = vi.fn(async () => jsonResponse(401, { error: 'Missing Authorization header' }))
    const onSessionLost = vi.fn()
    const call = createRequester({ fetch, stepUp: async () => true, onSessionLost })
    await expect(call('/api/invoke', { body: {} })).rejects.toMatchObject({ status: 401 })
    expect(onSessionLost).not.toHaveBeenCalled()
  })

  it('does not report session loss for a wrong TOTP code', async () => {
    const fetch = vi.fn(async () => jsonResponse(401, { error: 'Invalid TOTP code', code: 'TOTP_INVALID' }))
    const onSessionLost = vi.fn()
    const call = createRequester({ fetch, stepUp: async () => true, onSessionLost })
    await expect(call('/auth/totp/confirm', { body: { code: '000000' } })).rejects.toMatchObject({
      code: 'TOTP_INVALID',
    })
    expect(onSessionLost).not.toHaveBeenCalled()
  })

  it('sends no body and no content-type on bodiless requests', async () => {
    const fetch = vi.fn(async () => jsonResponse(200, { ok: true }))
    const call = createRequester({ fetch, stepUp: async () => true, onSessionLost: () => {} })
    await call('/admin/screen/c1/stop', { method: 'POST' })
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.body).toBeUndefined()
    expect(init.headers).toEqual({})
    expect(init.method).toBe('POST')
  })
})
