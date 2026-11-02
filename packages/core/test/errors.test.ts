import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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
const exitSection = section('## 6. 状态码与退出码', '### 6.1');
const docExit = new Map<string, number>();
for (const m of exitSection.matchAll(
  /^\|\s*`([a-z_]+)`\s*\|[^|]*\|\s*(\d+)\s*\|/gm,
)) {
  docExit.set(m[1]!, Number(m[2]));
}
// §6 row: | （用法错误） | 参数错误 | 2 |
const usageExit = /^\|\s*（用法错误）\s*\|[^|]*\|\s*(\d+)\s*\|/m.exec(exitSection);

// The runtime representative of the ErrorCode union is CODE_CLASSIFICATION's
// key set: Record<ErrorCode, ...> makes the compiler reject a missing or an
// extra key, so the two cannot drift apart.
const docCodes = docRows.map((r) => r.code).sort();
const codeSet = Object.keys(CODE_CLASSIFICATION).sort();
const textSet = Object.keys(ERROR_TEXT).sort();

describe('§6.1 error code table', () => {
  it('parses a non-trivial table from the design doc', () => {
    expect(docRows.length).toBeGreaterThanOrEqual(30);
    expect(new Set(docCodes).size).toBe(docCodes.length);
  });

  it('ErrorCode is exactly the documented set (both directions)', () => {
    expect(codeSet).toEqual(docCodes);
  });

  it('ERROR_TEXT keys are exactly the documented set (both directions)', () => {
    expect(textSet).toEqual(docCodes);
  });

  it('every ERROR_TEXT entry has non-empty what_happened and next_step', () => {
    for (const [code, t] of Object.entries(ERROR_TEXT)) {
      expect({ code, ok: t.what_happened.trim() !== '' && t.next_step.trim() !== '' }).toEqual({ code, ok: true });
    }
  });

  it('status matches the 归类状态 column', () => {
    for (const r of docRows) {
      const actual = CODE_CLASSIFICATION[r.code as ErrorCode].status;
      expect({ code: r.code, status: actual }).toEqual({ code: r.code, status: r.status });
    }
  });

  it('retryable matches the 可重试 column', () => {
    for (const r of docRows) {
      const code = r.code as ErrorCode;
      // 视情况: unjudged means yes (§6.1 note under the table).
      const expected = r.retryable !== '否';
      expect({ code, retryable: CODE_CLASSIFICATION[code].retryable }).toEqual({ code, retryable: expected });
      expect(RETRYABLE.has(code)).toBe(expected);
      expect(err(code, 'x').retryable).toBe(expected);
    }
  });

  it('only 视情况 codes need the retryable override, and the override wins', () => {
    const situational = docRows.filter((r) => r.retryable === '视情况').map((r) => r.code);
    expect(situational).toEqual(['UPSTREAM_ERROR']);
    expect(err('UPSTREAM_ERROR', 'HTTP 404', { retryable: false }).retryable).toBe(false);
    expect(err('UPSTREAM_ERROR', 'HTTP 502', { retryable: true }).retryable).toBe(true);
  });

  it('RETRYABLE is exactly the codes classified as retryable', () => {
    const fromTable = Object.entries(CODE_CLASSIFICATION).filter(([, v]) => v.retryable).map(([k]) => k).sort();
    expect([...RETRYABLE].sort()).toEqual(fromTable);
  });

  it('AUTH_ERRORS is every needs_reauth code plus AUTH_REJECTED', () => {
    const expected = Object.entries(CODE_CLASSIFICATION)
      .filter(([, v]) => v.status === 'needs_reauth')
      .map(([k]) => k)
      .concat('AUTH_REJECTED')
      .sort();
    expect([...AUTH_ERRORS].sort()).toEqual(expected);
  });
});

describe('§6 exit codes', () => {
  it('parses all 9 statuses from the design doc', () => {
    expect(docExit.size).toBe(9);
  });

  it('EXIT_CODE matches the table exactly', () => {
    expect(Object.fromEntries(docExit)).toEqual({ ...EXIT_CODE });
  });

  it('USAGE_EXIT_CODE matches the （用法错误） row', () => {
    expect(usageExit).not.toBeNull();
    expect(USAGE_EXIT_CODE).toBe(Number(usageExit![1]));
  });

  it('every classification status has an exit code', () => {
    for (const v of Object.values(CODE_CLASSIFICATION)) {
      expect(EXIT_CODE[v.status]).toBeTypeOf('number');
    }
  });
});
