// 后台 API 的请求层（纯逻辑，不依赖 DOM / React，便于在 vitest node 环境里测）。
//
// 契约：
// - 未登录访问后台接口：401 {error, code: 'NO_SESSION' | 'SESSION_EXPIRED'}
// - 缺二次验证：403 {code: 'STEP_UP_REQUIRED', ...}
// 这两类是后台会话码，不属于设计方案 §6.1 的 ErrorCode。

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly nextStep?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** 前端自己产生的码：用户取消了二次验证对话框 */
export const STEP_UP_CANCELLED = 'STEP_UP_CANCELLED'

/**
 * 登录、二次验证、TOTP 确认等接口在"凭据不对"时也回 401，
 * 这些不代表会话丢失，不能把人踢回登录页。
 */
const CREDENTIAL_FAILURE_CODES = new Set([
  'INVALID_CREDENTIALS',
  'TOTP_REQUIRED',
  'TOTP_INVALID',
  'PASSKEY_FAILED',
])

/** 401 且不是凭据错误，视为后台会话丢失（NO_SESSION / SESSION_EXPIRED 及未知码） */
export function isSessionLost(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 401) return false
  return err.code === undefined || !CREDENTIAL_FAILURE_CODES.has(err.code)
}

export function isStepUpRequired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403 && err.code === 'STEP_UP_REQUIRED'
}

/** 把非 2xx 响应体转成 ApiError。兼容 {error, code} 与 {code, what_happened, next_step} 两种形态。 */
export function toApiError(status: number, statusText: string, body: unknown, text: string): ApiError {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
  const message =
    str(b['what_happened']) ?? str(b['message']) ?? str(b['error']) ?? (text !== '' ? text : statusText)
  return new ApiError(status, str(b['code']), message, str(b['next_step']))
}

/**
 * 二次验证重试包装：请求返回 403 STEP_UP_REQUIRED 时调用 stepUp()（弹验证框），
 * 验证成功后自动重试原请求一次；第二次仍失败则原样抛出，不再弹框。
 */
export async function withStepUp<T>(run: () => Promise<T>, stepUp: () => Promise<boolean>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (!isStepUpRequired(err)) throw err
    const ok = await stepUp()
    if (!ok) {
      throw new ApiError(403, STEP_UP_CANCELLED, '已取消二次验证，操作未执行')
    }
    return run()
  }
}

/**
 * 同一时刻只弹一个验证框：并发的多个 403 共享同一次验证结果。
 * prompt 为 null（对话框尚未挂载）时直接返回 false。
 */
export function createStepUpGate(): {
  setPrompt: (prompt: (() => Promise<boolean>) | null) => void
  request: () => Promise<boolean>
} {
  let prompt: (() => Promise<boolean>) | null = null
  let inflight: Promise<boolean> | null = null
  return {
    setPrompt(p) {
      prompt = p
    },
    request() {
      if (inflight) return inflight
      if (!prompt) return Promise.resolve(false)
      const current = prompt()
        .catch(() => false)
        .finally(() => {
          inflight = null
        })
      inflight = current
      return current
    },
  }
}

export interface CallOptions {
  method?: 'GET' | 'POST' | 'DELETE'
  /** 会被 JSON.stringify；省略则不发 body，也不带 content-type */
  body?: unknown
  /** 默认 true。二次验证接口自身必须关掉，避免循环 */
  stepUp?: boolean
  /** 默认 true。登录、初始化接口关掉：它们的 401 是凭据错误，不是会话丢失 */
  sessionLost?: boolean
}

export interface RequesterDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  stepUp: () => Promise<boolean>
  onSessionLost: (err: ApiError) => void
}

export function createRequester(deps: RequesterDeps) {
  const doFetch = deps.fetch

  async function once<T>(path: string, opts: CallOptions): Promise<T> {
    const hasBody = opts.body !== undefined
    const resp = await doFetch(path, {
      method: opts.method ?? (hasBody ? 'POST' : 'GET'),
      credentials: 'include',
      headers: hasBody ? { 'content-type': 'application/json' } : {},
      ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
    })
    const text = await resp.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    if (!resp.ok) throw toApiError(resp.status, resp.statusText, body, text)
    return body as T
  }

  return async function call<T>(path: string, opts: CallOptions = {}): Promise<T> {
    try {
      if (opts.stepUp === false) return await once<T>(path, opts)
      return await withStepUp(() => once<T>(path, opts), deps.stepUp)
    } catch (err) {
      // /api/* 用客户端 Bearer 令牌鉴权，它的 401 与后台会话无关
      const adminPath = !path.startsWith('/api/')
      if (opts.sessionLost !== false && adminPath && isSessionLost(err)) deps.onSessionLost(err as ApiError)
      throw err
    }
  }
}

const AUTH_ERROR_TEXT: Record<string, string> = {
  INVALID_CREDENTIALS: '用户名或密码不正确。',
  TOTP_REQUIRED: '该账号已启用 TOTP，请填写验证码。',
  TOTP_INVALID: '验证码不正确或已过期。',
  TOTP_NOT_ENABLED: '尚未启用 TOTP。',
  PASSKEY_FAILED: 'Passkey 验证未通过。',
  NO_PASSKEY: '还没有注册 Passkey。',
  PASSKEY_REGISTRATION_FAILED: 'Passkey 注册未通过校验。',
  ALREADY_BOOTSTRAPPED: '管理员已存在，请直接登录。',
  NO_SESSION: '尚未登录。',
  SESSION_EXPIRED: '登录已过期，请重新登录。',
  STEP_UP_REQUIRED: '需要二次验证。',
  [STEP_UP_CANCELLED]: '已取消二次验证，操作未执行。',
}

/** 认证相关错误给人看的中文说明；未知码回落到服务端 message */
export function describeAuthError(err: unknown): string {
  if (err instanceof ApiError) {
    const text = err.code !== undefined ? AUTH_ERROR_TEXT[err.code] : undefined
    if (text !== undefined) return text
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

/** React Query 的 retry 判定：401/403 不重试（否则会重复弹验证框或重复踢回登录） */
export function shouldRetryQuery(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return false
  return failureCount < 1
}
