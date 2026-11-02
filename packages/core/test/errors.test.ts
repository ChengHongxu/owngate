import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  CODE_CLASSIFICATION,
  EXIT_CODE,
  RETRYABLE,
  AUTH_ERRORS,
  err,
  type EnvelopeStatus,
  type ErrorCode,
} from '../src/errors/index.js';

// packages/core/test → repo root
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const doc = readFileSync(resolve(repoRoot, '设计方案.md'), 'utf8');

function section(startHeading: string, endHeading: string): string {
  const start = doc.indexOf(startHeading);
  const end = doc.indexOf(endHeading, start + startHeading.length);
  if (start < 0 || end < 0) throw new Error(`section not found: ${startHeading}`);
  return doc.slice(start, end);
}

interface DocRow {
  code: string;
  status: string;
  retryable: '是' | '否' | '视情况';
}

// §6.1 rows: | `CODE` | status（可选注释） | 是/否/视情况 | 说明 |
const docRows: DocRow[] = [];
for (const m of section('### 6.1 错误码全表', '\n## 7.').matchAll(
  /^\|\s*`([A-Z_]+)`\s*\|\s*([a-z_]+)[^|]*\|\s*(是|否|视情况)\s*\|/gm,
)) {
  docRows.push({ code: m[1]!, status: m[2]!, retryable: m[3] as DocRow['retryable'] });
}

// §6 rows: | `status` | 含义 | 退出码 |
const docExit = new Map<string, number>();
for (const m of section('## 6. 状态码与退出码', '### 6.1').matchAll(
  /^\|\s*`([a-z_]+)`\s*\|[^|]*\|\s*(\d+)\s*\|/gm,
)) {
  docExit.set(m[1]!, Number(m[2]));
}

const classified = CODE_CLASSIFICATION as Readonly<Record<string, { status: EnvelopeStatus; retryable: boolean } | undefined>>;

describe('§6.1 error code table', () => {
  it('parses a non-trivial table from the design doc', () => {
    expect(docRows.length).toBeGreaterThanOrEqual(20);
  });

  it('every documented code is classified', () => {
    const missing = docRows.filter((r) => classified[r.code] === undefined).map((r) => r.code);
    expect(missing).toEqual([]);
  });

  it('status matches the 归类状态 column', () => {
    for (const r of docRows) {
      expect({ code: r.code, status: classified[r.code]?.status }).toEqual({ code: r.code, status: r.status });
    }
  });

  it('retryable matches the 可重试 column', () => {
    for (const r of docRows) {
      if (r.retryable === '视情况') continue;
      const expected = r.retryable === '是';
      expect({ code: r.code, retryable: classified[r.code]?.retryable }).toEqual({ code: r.code, retryable: expected });
      expect(RETRYABLE.has(r.code as ErrorCode)).toBe(expected);
      expect(err(r.code as ErrorCode, 'x').retryable).toBe(expected);
    }
  });

  it('RETRYABLE is exactly the codes classified as retryable', () => {
    const fromTable = Object.entries(CODE_CLASSIFICATION).filter(([, v]) => v.retryable).map(([k]) => k).sort();
    expect([...RETRYABLE].sort()).toEqual(fromTable);
  });

  it('AUTH_ERRORS covers every needs_reauth code and keeps legacy members', () => {
    for (const [code, v] of Object.entries(CODE_CLASSIFICATION)) {
      if (v.status === 'needs_reauth') expect(AUTH_ERRORS.has(code as ErrorCode)).toBe(true);
    }
    expect(AUTH_ERRORS.has('NEEDS_AUTH')).toBe(true);
    expect(AUTH_ERRORS.has('AUTH_FAILED')).toBe(true);
    expect(AUTH_ERRORS.has('AUTH_REJECTED')).toBe(true);
  });
});

describe('§6 exit codes', () => {
  it('parses all 9 statuses from the design doc', () => {
    expect(docExit.size).toBe(9);
  });

  it('EXIT_CODE matches the table exactly', () => {
    expect(Object.fromEntries(docExit)).toEqual({ ...EXIT_CODE });
  });

  it('every classification status has an exit code', () => {
    for (const v of Object.values(CODE_CLASSIFICATION)) {
      expect(EXIT_CODE[v.status]).toBeTypeOf('number');
    }
  });
});
