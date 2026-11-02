// Canonical error codes — single source of truth for all three entry points.
// Design doc §6.1: the ErrorCode set, CODE_CLASSIFICATION and ERROR_TEXT must
// be exactly the codes in the 错误码全表 (test/errors.test.ts checks all three
// against the doc in both directions).
// Design doc §9.1: same error means the same thing across CLI/MCP/backend.

export type ErrorCode =
  // ── 客户端与请求 ────────────────────────────────
  | 'UNAUTHENTICATED'          // 客户端令牌缺失、无效或过期
  | 'CLIENT_REVOKED'           // 客户端已被撤销，令牌即时失效
  | 'CONNECTION_NOT_FOUND'     // connection_id 不存在
  | 'CAPABILITY_NOT_FOUND'     // 能力 ID 不存在
  | 'PERMISSION_DENIED'        // 客户端无此授权
  | 'GRANT_REVOKED'            // 授权被撤销
  | 'INVALID_PARAMS'           // 参数不满足 schema（CLI 退出码 2）

  // ── 站点凭据 ────────────────────────────────────
  | 'AUTH_EXPIRED'             // 令牌或登录态失效
  | 'AUTH_MISSING'             // 从未授权
  | 'AUTH_REJECTED'            // 凭据被站点拒绝（非过期）
  | 'LOGIN_REQUIRED'           // 页面跳转到登录
  | 'CAPTCHA_PRESENT'          // 出现验证码，需人工处理

  // ── 能力状态 ────────────────────────────────────
  | 'CAPABILITY_UNSUPPORTED'   // 该连接不支持此能力
  | 'CAPABILITY_DISABLED'      // 用户已关闭
  | 'PLAN_INSUFFICIENT'        // 站点套餐档位不足

  // ── 执行 ────────────────────────────────────────
  | 'RATE_LIMITED'             // 站点限流
  | 'UPSTREAM_TIMEOUT'         // 站点或网络超时
  | 'UPSTREAM_UNAVAILABLE'     // 站点不可达
  | 'UPSTREAM_ERROR'           // 站点返回错误
  | 'PARSE_FAILED'             // 响应不符合预期结构
  | 'ITEM_PARSE_FAILED'        // 列表中的单条失败
  | 'RISK_CONTROL_DETECTED'    // 命中风控页，连接已暂停
  | 'BROWSER_UNAVAILABLE'      // worker 或浏览器故障
  | 'CONNECTOR_CRASHED'        // 适配器进程崩溃
  | 'CIRCUIT_OPEN'             // 连接已熔断

  // ── 写操作（D9，本期不开放，但框架就位）──────────
  | 'APPROVAL_REQUIRED'        // 写操作待批准
  | 'APPROVAL_EXPIRED'         // 批准超时
  | 'APPROVAL_CONTENT_CHANGED' // 内容变更导致批准失效
  | 'OUTCOME_UNKNOWN'          // 写操作结果不明

  // ── 内部 ────────────────────────────────────────
  | 'INTERNAL_ERROR';          // 未归类异常

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
 * 每个错误码的归类状态与可重试性，严格按 §6.1「归类状态」「可重试」两列。
 * `UPSTREAM_ERROR` 在表中为「视情况」：站点 5xx 可重试、4xx 不可重试，
 * 由执行器通过 err() 的 retryable 覆盖判定；未判定时按可重试处理。
 */
export const CODE_CLASSIFICATION: Readonly<Record<ErrorCode, Readonly<CodeClassification>>> = Object.freeze({
  UNAUTHENTICATED: { status: 'forbidden', retryable: false },
  CLIENT_REVOKED: { status: 'forbidden', retryable: false },
  CONNECTION_NOT_FOUND: { status: 'error', retryable: false },
  CAPABILITY_NOT_FOUND: { status: 'error', retryable: false },
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
});

export interface ErrorText {
  /** 发生了什么（给人看，不含站点原文）。 */
  what_happened: string;
  /** 下一步该做什么。 */
  next_step: string;
}

/**
 * 每个错误码的中文默认文案，CLI、MCP、后台共用（§6.1）。
 * 调用方有更具体的信息（连接名、站点原因）时用自己的 message，
 * 缺少 next_step 时从这里补齐。
 */
export const ERROR_TEXT: Readonly<Record<ErrorCode, Readonly<ErrorText>>> = Object.freeze({
  UNAUTHENTICATED: {
    what_happened: '客户端令牌缺失、无效或已过期',
    next_step: '在后台签发新的客户端令牌，并用 webridge login 或 MCP 配置更新',
  },
  CLIENT_REVOKED: {
    what_happened: '该客户端已被撤销，令牌已失效',
    next_step: '如需继续使用，请在后台重新创建客户端并签发令牌',
  },
  CONNECTION_NOT_FOUND: {
    what_happened: '指定的连接不存在',
    next_step: '用 webridge conn ls 查看可用的连接 ID',
  },
  CAPABILITY_NOT_FOUND: {
    what_happened: '该连接上没有这个能力',
    next_step: '用 webridge cap ls <connection_id> 查看可用的能力 ID',
  },
  AUTH_EXPIRED: {
    what_happened: '站点的访问令牌或登录态已失效',
    next_step: '在后台重新登录该连接或重新填写令牌',
  },
  AUTH_MISSING: {
    what_happened: '该连接还没有授权过',
    next_step: '在后台为该连接完成登录或填写令牌',
  },
  AUTH_REJECTED: {
    what_happened: '站点拒绝了该连接的凭据',
    next_step: '在后台检查并更新该连接的凭据',
  },
  PERMISSION_DENIED: {
    what_happened: '当前客户端没有调用此能力的授权',
    next_step: '在后台为该客户端添加对应连接和能力的授权',
  },
  GRANT_REVOKED: {
    what_happened: '该客户端对此连接的授权已被撤销',
    next_step: '如需继续使用，请在后台重新授权',
  },
  CAPABILITY_UNSUPPORTED: {
    what_happened: '该连接不支持此能力',
    next_step: '用 webridge cap ls <connection_id> 查看该连接支持的能力',
  },
  CAPABILITY_DISABLED: {
    what_happened: '此能力已被关闭',
    next_step: '如需使用，请在后台开启该能力；写操作本期不开放',
  },
  PLAN_INSUFFICIENT: {
    what_happened: '站点账号的套餐档位不足，无法使用此能力',
    next_step: '在站点升级套餐后，在后台重新探测该连接',
  },
  INVALID_PARAMS: {
    what_happened: '请求参数不满足能力的输入要求',
    next_step: '对照能力的输入 schema 修正参数后重试',
  },
  RATE_LIMITED: {
    what_happened: '站点限流，请求被拒绝',
    next_step: '稍后重试',
  },
  UPSTREAM_TIMEOUT: {
    what_happened: '站点或网络超时',
    next_step: '稍后重试；持续超时请检查站点与出网代理',
  },
  UPSTREAM_UNAVAILABLE: {
    what_happened: '站点暂时不可达',
    next_step: '稍后重试；持续失败请检查网络与出网代理',
  },
  UPSTREAM_ERROR: {
    what_happened: '站点返回了错误',
    next_step: '可重试时稍后重试，否则在后台查看该连接的状态',
  },
  PARSE_FAILED: {
    what_happened: '站点响应不符合预期结构，可能是站点改版',
    next_step: '在后台查看该连接的状态；需要更新适配器',
  },
  ITEM_PARSE_FAILED: {
    what_happened: '列表中有条目解析失败，其余条目正常返回',
    next_step: '逐条查看结果中的 error；持续出现需要更新适配器',
  },
  RISK_CONTROL_DETECTED: {
    what_happened: '命中站点风控页，连接已自动暂停',
    next_step: '在后台打开远程画面人工处理后再恢复该连接',
  },
  LOGIN_REQUIRED: {
    what_happened: '站点页面跳转到了登录页',
    next_step: '在后台打开远程画面重新登录该连接',
  },
  CAPTCHA_PRESENT: {
    what_happened: '站点出现验证码，需要人工处理',
    next_step: '在后台打开远程画面完成验证',
  },
  BROWSER_UNAVAILABLE: {
    what_happened: '浏览器 worker 或浏览器故障',
    next_step: '稍后重试；持续失败请检查 browser 服务',
  },
  CONNECTOR_CRASHED: {
    what_happened: '适配器进程崩溃',
    next_step: '稍后重试；持续失败请查看服务日志',
  },
  APPROVAL_REQUIRED: {
    what_happened: '写操作需要人工批准',
    next_step: '在后台审批后再查看任务结果',
  },
  APPROVAL_EXPIRED: {
    what_happened: '批准已超时失效',
    next_step: '重新提交写操作并在时限内批准',
  },
  APPROVAL_CONTENT_CHANGED: {
    what_happened: '写操作内容已变更，原批准失效',
    next_step: '重新提交写操作并再次批准',
  },
  OUTCOME_UNKNOWN: {
    what_happened: '写操作结果不明',
    next_step: '先到站点核对结果，不要直接重试',
  },
  CIRCUIT_OPEN: {
    what_happened: '该连接连续失败，已熔断',
    next_step: '稍后重试；在后台查看该连接的失败原因',
  },
  INTERNAL_ERROR: {
    what_happened: '服务内部异常',
    next_step: '稍后重试；持续失败请查看服务日志',
  },
});

/** CLI 退出码（设计文档 §6）。 */
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

/**
 * 用法错误的 CLI 退出码（§6「（用法错误）」行）。它不是信封状态：
 * INVALID_PARAMS 归类为 error，但 CLI 对它和命令行用法错误都退出 2。
 */
export const USAGE_EXIT_CODE = 2;

const ALL_CODES = Object.keys(CODE_CLASSIFICATION) as ErrorCode[];

export interface ApiError {
  code: ErrorCode;
  message: string;          // 给人看的说明
  retryable: boolean;       // 是否值得重试
  details?: unknown;        // 站点原始响应或调试信息（已脱敏）
}

/** 默认可重试的码。派生自 CODE_CLASSIFICATION 的 retryable 列。 */
export const RETRYABLE: ReadonlySet<ErrorCode> = new Set(
  ALL_CODES.filter((c) => CODE_CLASSIFICATION[c].retryable),
);

/**
 * 哪些错误表示凭据/登录态问题，应触发重新探测：
 * 归类为 needs_reauth 的码，外加站点拒绝凭据的 AUTH_REJECTED（归类为 error）。
 */
export const AUTH_ERRORS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ...ALL_CODES.filter((c) => CODE_CLASSIFICATION[c].status === 'needs_reauth'),
  'AUTH_REJECTED',
]);

export interface ErrOptions {
  /** 站点原始响应或调试信息（已脱敏）。 */
  details?: unknown;
  /**
   * 覆盖表中的可重试性。只用于 §6.1 标为「视情况」的码，
   * 例如 UPSTREAM_ERROR：站点 5xx 为 true，4xx 为 false。
   */
  retryable?: boolean;
}

export function err(code: ErrorCode, message: string, opts: ErrOptions = {}): ApiError {
  return {
    code,
    message,
    retryable: opts.retryable ?? CODE_CLASSIFICATION[code].retryable,
    ...(opts.details !== undefined ? { details: opts.details } : {}),
  };
}
