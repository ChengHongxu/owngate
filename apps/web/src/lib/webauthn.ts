// Passkey 可用性判断（纯函数）。
// WebAuthn 只在安全上下文（https 或 localhost）下可用。用户常先用 http://<IP> 试用，
// 那时要隐藏 Passkey 入口，TOTP 路径独立可用。

export interface WebAuthnEnv {
  isSecureContext?: boolean
  PublicKeyCredential?: unknown
}

export type PasskeySupport =
  | { available: true }
  | { available: false; reason: 'insecure_context' | 'unsupported_browser'; message: string }

export const INSECURE_CONTEXT_MESSAGE = 'Passkey 需要 HTTPS 域名访问，当前可用 TOTP。'
export const UNSUPPORTED_BROWSER_MESSAGE = '当前浏览器不支持 Passkey，可用 TOTP。'

export function passkeySupport(env: WebAuthnEnv | undefined): PasskeySupport {
  if (env?.isSecureContext !== true) {
    return { available: false, reason: 'insecure_context', message: INSECURE_CONTEXT_MESSAGE }
  }
  if (typeof env.PublicKeyCredential !== 'function') {
    return { available: false, reason: 'unsupported_browser', message: UNSUPPORTED_BROWSER_MESSAGE }
  }
  return { available: true }
}

/** 在浏览器里读取当前环境；SSR / node 下返回 undefined */
export function currentWebAuthnEnv(): WebAuthnEnv | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window as unknown as { isSecureContext?: boolean; PublicKeyCredential?: unknown }
  return {
    isSecureContext: w.isSecureContext === true,
    ...(w.PublicKeyCredential !== undefined ? { PublicKeyCredential: w.PublicKeyCredential } : {}),
  }
}

/** WebAuthn 调用失败时给人看的话。用户取消（NotAllowedError）最常见。 */
export function describeWebAuthnError(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError') return '已取消，或验证超时。可以再试一次。'
  if (name === 'InvalidStateError') return '这个设备上已经注册过 Passkey。'
  if (name === 'SecurityError') return '当前地址不能使用 Passkey：域名需与服务配置的 origin 一致且为 HTTPS。'
  return err instanceof Error ? err.message : String(err)
}
