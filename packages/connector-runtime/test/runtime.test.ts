import { describe, it, expect } from 'vitest';
import { pathGet, pathGetAll, parsePath } from '../src/path.js';
import { evalExpr } from '../src/expr.js';
import { renderTemplate, renderObject } from '../src/template.js';
import { applyTransform } from '../src/transforms.js';

// ── JSONPath ───────────────────────────────────────────────────────────────

describe('pathGet', () => {
  const root = {
    data: { quota: 500, used_quota: 100, email: 'a@b.com' },
    success: true,
    items: [{ id: 1 }, { id: 2 }, { id: 3 }],
  };

  it('gets a nested value', () => {
    expect(pathGet(root, '$.data.quota')).toBe(500);
  });

  it('gets root property', () => {
    expect(pathGet(root, '$.success')).toBe(true);
  });

  it('gets array element', () => {
    expect(pathGet(root, '$.items[1]')).toEqual({ id: 2 });
  });

  it('gets negative array index', () => {
    expect(pathGet(root, '$.items[-1]')).toEqual({ id: 3 });
  });

  it('returns undefined for missing path', () => {
    expect(pathGet(root, '$.data.missing')).toBeUndefined();
  });

  it('bracket notation for member access', () => {
    expect(pathGet(root, "$['data']['quota']")).toBe(500);
  });
});

describe('pathGetAll wildcard', () => {
  const root = { data: [{ id: 1 }, { id: 2 }, { id: 3 }] };

  it('expands wildcard on array', () => {
    const result = pathGetAll(root, '$.data[*]');
    expect(result).toHaveLength(3);
  });

  it('expands .* on object', () => {
    const result = pathGetAll({ a: 1, b: 2 }, '$.*');
    expect(result).toContain(1);
    expect(result).toContain(2);
  });
});

// ── Expression engine ─────────────────────────────────────────────────────

describe('evalExpr', () => {
  const ctx = (response: unknown, status: number | 'ok' = 200) => ({ response, status });

  it('simple equality', () => {
    const r = evalExpr('$.success == true', ctx({ success: true }));
    expect(r.value).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });

  it('status check', () => {
    expect(evalExpr('status == 200', ctx({}, 200)).value).toBe(true);
    expect(evalExpr('status in [401, 403]', ctx({}, 401)).value).toBe(true);
    expect(evalExpr('status in [401, 403]', ctx({}, 200)).value).toBe(false);
  });

  it('and / or', () => {
    expect(evalExpr('$.a == 1 and $.b == 2', ctx({ a: 1, b: 2 })).value).toBe(true);
    expect(evalExpr('$.a == 1 and $.b == 3', ctx({ a: 1, b: 2 })).value).toBe(false);
    expect(evalExpr('$.a == 9 or $.b == 2', ctx({ a: 1, b: 2 })).value).toBe(true);
  });

  it('! negation', () => {
    expect(evalExpr('!$.success', ctx({ success: false })).value).toBe(true);
    expect(evalExpr('!$.success', ctx({ success: true })).value).toBe(false);
  });

  it('numeric comparisons', () => {
    expect(evalExpr('$.quota > 100', ctx({ quota: 200 })).value).toBe(true);
    expect(evalExpr('$.quota <= 100', ctx({ quota: 50 })).value).toBe(true);
  });

  it('type mismatch records warning', () => {
    const r = evalExpr('$.value > "string"', ctx({ value: 42 }));
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.value).toBe(false);
  });

  it('parenthesised groups', () => {
    expect(evalExpr('($.a == 1 or $.a == 2) and $.b == 3', ctx({ a: 2, b: 3 })).value).toBe(true);
  });

  it('contains operator', () => {
    expect(evalExpr('$.tags contains "vip"', ctx({ tags: ['vip', 'pro'] })).value).toBe(true);
  });

  it('!= operator', () => {
    expect(evalExpr('$.status != "error"', ctx({ status: 'ok' })).value).toBe(true);
  });
});

// ── Template rendering ────────────────────────────────────────────────────

describe('renderTemplate', () => {
  const tplCtx = {
    config: { base_url: 'https://api.example.com', user_id: '42' },
    secret: { access_token: 'tok-abc' },
    input: { limit: '10', query: 'hello world' },
  };

  it('replaces config placeholder', () => {
    const { value } = renderTemplate('{{config.base_url}}/api', tplCtx);
    expect(value).toBe('https://api.example.com/api');
  });

  it('replaces secret placeholder', () => {
    const { value } = renderTemplate('Bearer {{secret.access_token}}', tplCtx);
    expect(value).toBe('Bearer tok-abc');
  });

  it('URL-encodes input when flag set', () => {
    const { value } = renderTemplate('/search?q={{input.query}}', tplCtx, { urlEncodeInput: true });
    expect(value).toBe('/search?q=hello%20world');
  });

  it('does not URL-encode input by default', () => {
    const { value } = renderTemplate('/search?q={{input.query}}', tplCtx);
    expect(value).toBe('/search?q=hello world');
  });

  it('warns on unknown field', () => {
    const { warnings } = renderTemplate('{{config.missing}}', tplCtx);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('renders multiple placeholders', () => {
    const { value } = renderTemplate('{{config.base_url}}/user/{{config.user_id}}', tplCtx);
    expect(value).toBe('https://api.example.com/user/42');
  });
});

// ── Transforms ────────────────────────────────────────────────────────────

describe('applyTransform', () => {
  it('quota_to_usd converts with ratio', () => {
    expect(applyTransform('quota_to_usd', 500000, { quota_per_unit: 1000 })).toBe(500);
  });

  it('quota_to_usd returns null when ratio unknown', () => {
    expect(applyTransform('quota_to_usd', 500, {})).toBeNull();
  });

  it('seconds_to_ms', () => {
    expect(applyTransform('seconds_to_ms', 3, {})).toBe(3000);
  });

  it('unix_to_iso', () => {
    const r = applyTransform('unix_to_iso', 0, {});
    expect(typeof r).toBe('string');
    expect(r as string).toContain('1970');
  });

  it('strip_html removes tags', () => {
    expect(applyTransform('strip_html', '<b>hello</b> &amp; world', {})).toBe('hello & world');
  });

  it('pick_first returns first element', () => {
    expect(applyTransform('pick_first', [10, 20, 30], {})).toBe(10);
  });

  it('number_or_null coerces numeric strings', () => {
    expect(applyTransform('number_or_null', '42', {})).toBe(42);
    expect(applyTransform('number_or_null', 'abc', {})).toBeNull();
  });

  it('throws on unknown transform', () => {
    expect(() => applyTransform('nonexistent', 1, {})).toThrow(/Unknown transform/);
  });
});
