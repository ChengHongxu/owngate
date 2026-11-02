// Canonical error codes — single source of truth for all three entry points.
// Design doc §6: "区分零值、未知、不可获取、过期和查询失败"
// Design doc §9.1: same error means the same thing across CLI/MCP/backend.

export type ErrorCode =
  // ── 请求级（调用方问题）──────────────────────────
  | 'INVALID_INPUT'        // 参数不通过 schema 校验
  | 'UNAUTHORIZED'          // 客户端未认证或令牌失效
  | 'FORBIDDEN'             // 认证但无权调用此能力
  | 'CLIENT_REVOKED'        // 客户端已撤销，令牌即时失效
  | 'CONNECTION_NOT_FOUND'  // connection_id 不存在
  | 'CAPABILITY_NOT_FOUND'  // capability_id 不存在
  | 'NOT_SUPPORTED'         // 该连接不支持此能力（status != supported）

  // ── 凭据级 ──────────────────────────────────────
  | 'NEEDS_AUTH'            // 登录态失效，需重新授权
  | 'NEEDS_PLAN'            // 站点套餐/档位不足
  | 'AUTH_FAILED'           // 站点拒绝凭据（401/403）

  // ── 执行级 ──────────────────────────────────────
  | 'UPSTREAM_ERROR'        // 站点返回错误状态码或格式异常
  | 'TIMEOUT'               // 请求超时
  | 'RATE_LIMITED'          // 触发站点或本端限流
  | 'CIRCUIT_OPEN'          // 熔断中，请求被快速失败
  | 'CANCELLED'             // 本地取消成功
  | 'PARTIAL_DATA'          // 拿到部分数据，其余字段不可获取

  // ── 写操作级（D9，本期不开放，但框架就位）─────────
  | 'PROPOSAL_STALE'        // 提案内容已变，旧批准无效
  | 'APPROVAL_REQUIRED'     // 需要人工批准
  | 'UNKNOWN_OUTCOME'       // 执行结果不明，禁止盲目重试
  | 'ACTION_DISABLED'       // 本期所有 action 能力状态为 disabled

  // ── 内部级 ──────────────────────────────────────
  | 'INTERNAL_ERROR'        // 未预期的内部故障
  | 'RISK_CONTROL_DETECTED' // 平台风控触发，连接自动暂停

export interface ApiError {
  code: ErrorCode;
  message: string;          // 给人看的说明
  retryable: boolean;       // 是否值得重试
  details?: unknown;        // 站点原始响应或调试信息（已脱敏）
}

/** 哪些错误可以安全重试。保守起见，只有网络类瞬态错误为 true。 */
export const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  'TIMEOUT',
  'UPSTREAM_ERROR',
]);

/** 哪些错误表示凭据/登录态问题，应触发重新探测。 */
export const AUTH_ERRORS: ReadonlySet<ErrorCode> = new Set([
  'NEEDS_AUTH',
  'AUTH_FAILED',
]);

export function err(code: ErrorCode, message: string, details?: unknown): ApiError {
  return {
    code,
    message,
    retryable: RETRYABLE.has(code),
    details,
  };
}
