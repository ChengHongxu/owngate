// Result envelope — the single shape every capability result returns.
// Design doc §5: "统一结果信封：来源、双时间戳、缓存、单位、完整性、字段级状态"
// Design doc §3.2.1: x-* keywords carried through here.

import type { SupportState } from '../types/index.js';
import type { ApiError, ErrorCode } from '../errors/index.js';

/** Field-level status, parallel to output schema. */
export type FieldStatus =
  | 'ok'           // 有值
  | 'unknown'      // 站点不提供，不应填 0
  | 'unavailable'  // 本应可获取但本次失败
  | 'expired'      // 数据过期
  | 'redacted';    // 被脱敏移除

/** Per-field metadata, key matches output schema property name. */
export interface FieldMeta {
  status: FieldStatus;
  reason?: string;            // why this field is not 'ok'
  unit?: string;               // x-unit
  scope?: string;              // x-scope
  sensitivity?: 'pii' | 'financial' | 'content';
  untrusted?: boolean;         // x-untrusted
  dimension?: string;          // x-dimension
}

export interface ResultEnvelope<T = unknown> {
  /** success | error | partial */
  outcome: 'success' | 'error' | 'partial';
  /** data if outcome is success/partial, null on error */
  data: T | null;
  /** present when outcome is error or partial */
  error: ApiError | null;
  /** per-field status map, only for fields that are not 'ok' */
  fields: Record<string, FieldMeta>;
  /** which connection produced this result */
  source: {
    connection_id: string;
    connection_label: string;
    capability_id: string;
    support: SupportState;
  };
  /** data timestamp from the site; falls back to queried_at if site omits it */
  data_time: string;
  /** when we executed the query */
  queried_at: string;
  /** cache info if served from cache */
  cache: { hit: boolean; cached_at: string; expires_at: string; ttl: number } | null;
  /** warnings that didn't change outcome (e.g. type mismatch in expression) */
  warnings: string[];
}

/** Helper: build a success envelope with minimal boilerplate. */
export function ok<T>(
  data: T,
  source: ResultEnvelope['source'],
  opts: Partial<Pick<ResultEnvelope, 'fields' | 'data_time' | 'cache' | 'warnings'>> = {},
): ResultEnvelope<T> {
  return {
    outcome: 'success',
    data,
    error: null,
    fields: opts.fields ?? {},
    source,
    data_time: opts.data_time ?? new Date().toISOString(),
    queried_at: new Date().toISOString(),
    cache: opts.cache ?? null,
    warnings: opts.warnings ?? [],
  };
}

/** Helper: build an error envelope. */
export function fail(
  error: ApiError,
  source: ResultEnvelope['source'],
  opts: Partial<Pick<ResultEnvelope, 'fields' | 'warnings'>> = {},
): ResultEnvelope {
  return {
    outcome: 'error',
    data: null,
    error,
    fields: opts.fields ?? {},
    source,
    data_time: new Date().toISOString(),
    queried_at: new Date().toISOString(),
    cache: null,
    warnings: opts.warnings ?? [],
  };
}

/** Helper: build a partial envelope (some fields present, some unavailable). */
export function partial<T>(
  data: T,
  error: ApiError,
  source: ResultEnvelope['source'],
  opts: Partial<Pick<ResultEnvelope, 'fields' | 'data_time' | 'cache' | 'warnings'>> = {},
): ResultEnvelope<T> {
  return {
    outcome: 'partial',
    data,
    error,
    fields: opts.fields ?? {},
    source,
    data_time: opts.data_time ?? new Date().toISOString(),
    queried_at: new Date().toISOString(),
    cache: opts.cache ?? null,
    warnings: opts.warnings ?? [],
  };
}
