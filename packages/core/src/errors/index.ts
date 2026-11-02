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

  // ── 设计文档 §6.1 规范码（以上为早期码，保留以兼容调用点）──
  | 'AUTH_EXPIRED'             // 令牌或登录态失效
  | 'AUTH_MISSING'             // 从未授权
  | 'AUTH_REJECTED'            // 凭据被站点拒绝（非过期）
  | 'PERMISSION_DENIED'        // 客户端无此授权
  | 'GRANT_REVOKED'            // 授权被撤销
  | 'CAPABILITY_UNSUPPORTED'   // 该连接不支持此能力
  | 'CAPABILITY_DISABLED'      // 用户已关闭
  | 'PLAN_INSUFFICIENT'        // 站点套餐档位不足
  | 'INVALID_PARAMS'           // 参数不满足 schema（CLI 退出码 2）
  | 'UPSTREAM_TIMEOUT'         // 站点或网络超时
  | 'UPSTREAM_UNAVAILABLE'     // 站点不可达
  | 'PARSE_FAILED'             // 响应不符合预期结构
  | 'ITEM_PARSE_FAILED'        // 列表中的单条失败
  | 'LOGIN_REQUIRED'           // 页面跳转到登录
  | 'CAPTCHA_PRESENT'          // 出现验证码，需人工处理
  | 'BROWSER_UNAVAILABLE'      // worker 或浏览器故障
  | 'CONNECTOR_CRASHED'        // 适配器进程崩溃
  | 'APPROVAL_EXPIRED'         // 批准超时
  | 'APPROVAL_CONTENT_CHANGED' // 内容变更导致批准失效
  | 'OUTCOME_UNKNOWN';         // 写操作结果不明

/** 信封状态（设计文档 §6）。与 ErrorCode 是一对多关系。 */
export type EnvelopeStatus =
  | 'ok'
  | 'error'
  | 'partial'
  | 'pending'
  | 'needs_approval'
  | 'needs_reauth'
  | 'forbidden'
  | 'unsupported'
  | 'unknown_outcome';

export interface CodeClassification {
  status: EnvelopeStatus;
  retryable: boolean;
}

/**
 * 每个错误码的归类状态与可重试性。
 * §6.1 中的码严格按表中「归类状态」「可重试」两列；
 * `UPSTREAM_ERROR` 在表中为「视情况」，默认 true（与早期 RETRYABLE 一致），
 * 由调用方在具体场景下覆盖。
 * 早期码（不在 §6.1 中）按最接近的规范码归类，待文档定稿后合并。
 */
export const CODE_CLASSIFICATION: Readonly<Record<ErrorCode, Readonly<CodeClassification>>> = Object.freeze({
  // §6.1 规范码
  AUTH_EXPIRED: { status: 'needs_reauth', retryable: false },
  AUTH_MISSING: { status: 'needs_reauth', retryable: false },
  AUTH_REJECTED: { status: 'error', retryable: false },
  PERMISSION_DENIED: { status: 'forbidden', retryable: false },
  GRANT_REVOKED: { status: 'forbidden', retryable: false },
  CAPABILITY_UNSUPPORTED: { status: 'unsupported', retryable: false },
  CAPABILITY_DISABLED: { status: 'unsupported', retryable: false },
  PLAN_INSUFFICIENT: { status: 'unsupported', retryable: false },
  INVALID_PARAMS: { status: 'error', retryable: false },
  RATE_LIMITED: { status: 'error', retryable: true },
  UPSTREAM_TIMEOUT: { status: 'error', retryable: true },
  UPSTREAM_UNAVAILABLE: { status: 'error', retryable: true },
  UPSTREAM_ERROR: { status: 'error', retryable: true },
  PARSE_FAILED: { status: 'error', retryable: false },
  ITEM_PARSE_FAILED: { status: 'partial', retryable: false },
  RISK_CONTROL_DETECTED: { status: 'error', retryable: false },
  LOGIN_REQUIRED: { status: 'needs_reauth', retryable: false },
  CAPTCHA_PRESENT: { status: 'needs_reauth', retryable: false },
  BROWSER_UNAVAILABLE: { status: 'error', retryable: true },
  CONNECTOR_CRASHED: { status: 'error', retryable: true },
  APPROVAL_REQUIRED: { status: 'needs_approval', retryable: false },
  APPROVAL_EXPIRED: { status: 'needs_approval', retryable: false },
  APPROVAL_CONTENT_CHANGED: { status: 'error', retryable: false },
  OUTCOME_UNKNOWN: { status: 'unknown_outcome', retryable: false },
  CIRCUIT_OPEN: { status: 'error', retryable: true },
  INTERNAL_ERROR: { status: 'error', retryable: true },

  // 早期码（不在 §6.1 中）
  INVALID_INPUT: { status: 'error', retryable: false },          // ≈ INVALID_PARAMS
  UNAUTHORIZED: { status: 'forbidden', retryable: false },       // 客户端令牌无效
  FORBIDDEN: { status: 'forbidden', retryable: false },          // ≈ PERMISSION_DENIED
  CLIENT_REVOKED: { status: 'forbidden', retryable: false },     // ≈ GRANT_REVOKED
  CONNECTION_NOT_FOUND: { status: 'error', retryable: false },
  CAPABILITY_NOT_FOUND: { status: 'error', retryable: false },
  NOT_SUPPORTED: { status: 'unsupported', retryable: false },    // ≈ CAPABILITY_UNSUPPORTED
  NEEDS_AUTH: { status: 'needs_reauth', retryable: false },      // ≈ AUTH_EXPIRED
  NEEDS_PLAN: { status: 'unsupported', retryable: false },       // ≈ PLAN_INSUFFICIENT
  AUTH_FAILED: { status: 'error', retryable: false },            // ≈ AUTH_REJECTED
  TIMEOUT: { status: 'error', retryable: true },                 // ≈ UPSTREAM_TIMEOUT
  CANCELLED: { status: 'error', retryable: false },
  PARTIAL_DATA: { status: 'partial', retryable: false },         // ≈ ITEM_PARSE_FAILED
  PROPOSAL_STALE: { status: 'error', retryable: false },         // ≈ APPROVAL_CONTENT_CHANGED
  UNKNOWN_OUTCOME: { status: 'unknown_outcome', retryable: false }, // ≈ OUTCOME_UNKNOWN
  ACTION_DISABLED: { status: 'unsupported', retryable: false },  // ≈ CAPABILITY_DISABLED
});

/**
 * CLI 退出码（设计文档 §6）。
 * 用法错误（如 INVALID_PARAMS）不是独立状态，退出码为 2，由 CLI 层单独处理。
 */
export const EXIT_CODE: Readonly<Record<EnvelopeStatus, number>> = Object.freeze({
  ok: 0,
  error: 1,
  partial: 3,
  pending: 4,
  needs_approval: 5,
  needs_reauth: 6,
  forbidden: 7,
  unsupported: 8,
  unknown_outcome: 9,
});

const ALL_CODES = Object.keys(CODE_CLASSIFICATION) as ErrorCode[];

export interface ApiError {
  code: ErrorCode;
  message: string;          // 给人看的说明
  retryable: boolean;       // 是否值得重试
  details?: unknown;        // 站点原始响应或调试信息（已脱敏）
}

/** 哪些错误可以安全重试。派生自 CODE_CLASSIFICATION 的 retryable 列。 */
export const RETRYABLE: ReadonlySet<ErrorCode> = new Set(
  ALL_CODES.filter((c) => CODE_CLASSIFICATION[c].retryable),
);

/** 站点拒绝凭据但归类为 error 的码；它们同样应触发重新探测。 */
const CREDENTIAL_REJECTED: readonly ErrorCode[] = ['AUTH_REJECTED', 'AUTH_FAILED'];

/**
 * 哪些错误表示凭据/登录态问题，应触发重新探测。
 * 派生自 CODE_CLASSIFICATION 中 status 为 needs_reauth 的码，外加凭据被拒类。
 */
export const AUTH_ERRORS: ReadonlySet<ErrorCode> = new Set([
  ...ALL_CODES.filter((c) => CODE_CLASSIFICATION[c].status === 'needs_reauth'),
  ...CREDENTIAL_REJECTED,
]);

export function err(code: ErrorCode, message: string, details?: unknown): ApiError {
  return {
    code,
    message,
    retryable: RETRYABLE.has(code),
    details,
  };
}
