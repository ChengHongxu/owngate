import { describe, it, expect } from 'vitest';
import {
  CODE_CLASSIFICATION,
  ERROR_TEXT,
  EXIT_CODE,
  USAGE_EXIT_CODE,
  RETRYABLE,
  AUTH_ERRORS,
  err,
  type ErrorCode,
} from '../src/errors/index.js';

// Public error behavior is a stable client contract, independent of design documents.
const expectedGroups = [
  ['forbidden', false, ['UNAUTHENTICATED', 'CLIENT_REVOKED', 'PERMISSION_DENIED', 'GRANT_REVOKED']],
  ['needs_reauth', false, ['AUTH_EXPIRED', 'AUTH_MISSING', 'LOGIN_REQUIRED', 'CAPTCHA_PRESENT']],
  ['unsupported', false, ['CAPABILITY_UNSUPPORTED', 'CAPABILITY_DISABLED', 'PLAN_INSUFFICIENT']],
  ['error', false, ['CONNECTION_NOT_FOUND', 'CAPABILITY_NOT_FOUND', 'AUTH_REJECTED', 'INVALID_PARAMS', 'PARSE_FAILED', 'RISK_CONTROL_DETECTED', 'APPROVAL_CONTENT_CHANGED']],
  ['error', true, ['RATE_LIMITED', 'UPSTREAM_TIMEOUT', 'UPSTREAM_UNAVAILABLE', 'UPSTREAM_ERROR', 'BROWSER_UNAVAILABLE', 'CONNECTOR_CRASHED', 'CIRCUIT_OPEN', 'INTERNAL_ERROR']],
  ['partial', false, ['ITEM_PARSE_FAILED']],
  ['needs_approval', false, ['APPROVAL_REQUIRED', 'APPROVAL_EXPIRED']],
  ['unknown_outcome', false, ['OUTCOME_UNKNOWN']],
] as const;
const expectedClassification = Object.fromEntries(expectedGroups.flatMap(([status, retryable, codes]) => codes.map(code => [code, { status, retryable }])));

describe('error code contract', () => {
  it('preserves public statuses and retry defaults for all error codes', () => {
    expect(CODE_CLASSIFICATION).toEqual(expectedClassification);
  });

  it('provides actionable text for exactly the supported codes', () => {
    expect(Object.keys(ERROR_TEXT).sort()).toEqual(Object.keys(expectedClassification).sort());
    for (const text of Object.values(ERROR_TEXT)) {
      expect(text.what_happened.trim()).not.toBe('');
      expect(text.next_step.trim()).not.toBe('');
    }
  });

  it('uses the shared retry policy in returned errors', () => {
    for (const [code, { retryable }] of Object.entries(expectedClassification)) {
      expect(err(code as ErrorCode, 'x').retryable).toBe(retryable);
      expect(RETRYABLE.has(code as ErrorCode)).toBe(retryable);
    }
  });

  it('allows the executor to distinguish retryable 5xx from permanent 4xx', () => {
    expect(err('UPSTREAM_ERROR', 'HTTP 404', { retryable: false }).retryable).toBe(false);
    expect(err('UPSTREAM_ERROR', 'HTTP 502', { retryable: true }).retryable).toBe(true);
  });

  it('classifies authentication errors consistently', () => {
    expect([...AUTH_ERRORS].sort()).toEqual(['AUTH_EXPIRED', 'AUTH_MISSING', 'AUTH_REJECTED', 'CAPTCHA_PRESENT', 'LOGIN_REQUIRED'].sort());
  });
});

describe('exit code contract', () => {
  it('preserves the CLI status exit codes and usage error code', () => {
    expect(EXIT_CODE).toEqual({ ok: 0, error: 1, partial: 3, pending: 4, needs_approval: 5, needs_reauth: 6, forbidden: 7, unsupported: 8, unknown_outcome: 9 });
    expect(USAGE_EXIT_CODE).toBe(2);
  });

  it('has an exit code for every error classification', () => {
    for (const { status } of Object.values(CODE_CLASSIFICATION)) expect(EXIT_CODE[status]).toBeTypeOf('number');
  });
});
