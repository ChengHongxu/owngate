import { CODE_CLASSIFICATION, ERROR_TEXT, EXIT_CODE, USAGE_EXIT_CODE } from '@owngate/core'
import type { ApiError as CapabilityError, ErrorCode } from '@owngate/core'
import { ApiError, ApiTimeoutError } from './http.js'
import { CliResponseError, CliUsageError } from './errors.js'

function knownError(value: unknown): CapabilityError | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const error = value as Record<string, unknown>
  return typeof error['code'] === 'string' && Object.hasOwn(ERROR_TEXT, error['code']) ? error as unknown as CapabilityError : undefined
}

/** Two actionable lines by default; never print a response body or credential. */
export function reportCapabilityError(error: CapabilityError, verbose = false): void {
  const text = ERROR_TEXT[error.code]
  console.error(text?.what_happened ?? '请求未能完成。')
  console.error(text?.next_step ?? '请查看后台的连接状态后重试。')
  if (verbose) console.error(`Code: ${error.code}`)
}

export function reportCliFailure(error: unknown, verbose = false): number {
  if (error instanceof CliUsageError || error instanceof CliResponseError) {
    console.error(error.message)
    console.error(error.nextStep)
    return error instanceof CliUsageError ? USAGE_EXIT_CODE : 1
  }
  const body = error instanceof ApiError && typeof error.body === 'object' && error.body !== null
    ? error.body as Record<string, unknown> : undefined
  const capabilityError = knownError(body?.['error']) ?? knownError(body)
  if (capabilityError) {
    reportCapabilityError(capabilityError, verbose)
    return capabilityError.code === 'INVALID_PARAMS' ? USAGE_EXIT_CODE : EXIT_CODE[CODE_CLASSIFICATION[capabilityError.code].status]
  }
  let code: ErrorCode | undefined
  if (error instanceof ApiError && error.status === 401) code = 'UNAUTHENTICATED'
  if (error instanceof ApiError && error.status === 403) code = 'PERMISSION_DENIED'
  if (code) reportCapabilityError({ code, message: '', retryable: false }, verbose)
  else {
    console.error(error instanceof ApiTimeoutError ? '等待服务器响应超时。' : '无法完成服务器请求。')
    console.error('检查服务器地址和连接；用 owngate task ls 查看已接受的任务后，再决定是否重试。')
    if (verbose) console.error(error instanceof ApiError ? `HTTP status: ${error.status}` : `Failure type: ${error instanceof Error ? error.name : 'Unknown'}`)
  }
  return code ? EXIT_CODE[CODE_CLASSIFICATION[code].status] : 1
}
