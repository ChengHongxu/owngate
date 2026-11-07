import { describe, expect, it } from 'vitest'
import {
  INSECURE_CONTEXT_MESSAGE,
  UNSUPPORTED_BROWSER_MESSAGE,
  describeWebAuthnError,
  passkeySupport,
} from '../src/lib/webauthn'

class FakePublicKeyCredential {}

describe('passkeySupport', () => {
  it('is available in a secure context with PublicKeyCredential', () => {
    expect(passkeySupport({ isSecureContext: true, PublicKeyCredential: FakePublicKeyCredential })).toEqual({
      available: true,
    })
  })

  it('is unavailable over plain http://<IP> even if the API object exists', () => {
    const r = passkeySupport({ isSecureContext: false, PublicKeyCredential: FakePublicKeyCredential })
    expect(r).toEqual({ available: false, reason: 'insecure_context', message: INSECURE_CONTEXT_MESSAGE })
  })

  it('is unavailable over plain http when the API object is missing', () => {
    const r = passkeySupport({ isSecureContext: false })
    expect(r).toMatchObject({ available: false, reason: 'insecure_context' })
  })

  it('reports unsupported browsers in a secure context', () => {
    const r = passkeySupport({ isSecureContext: true })
    expect(r).toEqual({ available: false, reason: 'unsupported_browser', message: UNSUPPORTED_BROWSER_MESSAGE })
  })

  it('is unavailable with no window (node / SSR)', () => {
    expect(passkeySupport(undefined)).toMatchObject({ available: false, reason: 'insecure_context' })
  })

  it('explains access requirements without promising a TOTP fallback', () => {
    expect(INSECURE_CONTEXT_MESSAGE).toContain('HTTPS')
    expect(INSECURE_CONTEXT_MESSAGE).toContain('localhost')
    expect(INSECURE_CONTEXT_MESSAGE).not.toContain('TOTP')
    expect(UNSUPPORTED_BROWSER_MESSAGE).not.toContain('TOTP')
  })
})

describe('describeWebAuthnError', () => {
  it('maps user cancellation', () => {
    const e = new Error('The operation either timed out or was not allowed.')
    e.name = 'NotAllowedError'
    expect(describeWebAuthnError(e)).toContain('已取消')
  })

  it('falls back to the message', () => {
    expect(describeWebAuthnError(new Error('weird'))).toBe('weird')
  })
})
