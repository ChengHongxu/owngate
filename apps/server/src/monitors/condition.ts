import type { ResultEnvelope } from '@owngate/core';
import { MonitorError } from './types.js';

type Scalar = string | number | boolean | null;
type Ref = { kind: 'field' | 'state'; path: string } | { kind: 'status' };
type Node = { kind: 'comparison'; ref: Ref; op: string; value: Scalar | Scalar[] }
  | { kind: 'and'; left: Node; right: Node } | { kind: 'or'; left: Node; right: Node } | { kind: 'not'; value: Node };
interface Token { value: string; type: 'word' | 'number' | 'string' | 'symbol' }
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
export function validFieldPath(path: string): boolean {
  return path.length <= 150 && /^[a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)*$/.test(path)
    && !path.split('.').some((part) => FORBIDDEN.has(part));
}
export function fieldValue(root: unknown, path: string): unknown {
  if (!validFieldPath(path)) return undefined;
  let value = root;
  for (const part of path.split('.')) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function tokens(source: string): Token[] {
  const out: Token[] = [];
  let rest = source;
  while (rest.trim()) {
    rest = rest.trimStart();
    const match = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?:==|!=|>=|<=|[><!()[\],])|-?\d+(?:\.\d+)?|[A-Za-z_][\w.]*)/.exec(rest);
    if (!match) throw new MonitorError('INVALID_CONDITION', '条件中含有不支持的字符');
    const raw = match[0];
    const type = /^['"]/.test(raw) ? 'string' : /^-?\d/.test(raw) ? 'number' : /^[A-Za-z_]/.test(raw) ? 'word' : 'symbol';
    let value = raw;
    if (type === 'string') {
      try { value = raw[0] === '"' ? JSON.parse(raw) as string : raw.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\'); }
      catch { throw new MonitorError('INVALID_CONDITION', '条件中的字符串无效'); }
    }
    out.push({ type, value });
    if (out.length > 200) throw new MonitorError('INVALID_CONDITION', '条件过于复杂');
    rest = rest.slice(raw.length);
  }
  return out;
}

export interface CompiledCondition { root: Node; paths: string[]; states: string[]; usesStatus: boolean }
export function compileCondition(source: string, mode: 'data' | 'failure'): CompiledCondition {
  if (!source.trim() || source.length > 1000) throw new MonitorError('INVALID_CONDITION', '条件需要 1 到 1000 个字符');
  const ts = tokens(source);
  let pos = 0;
  const paths = new Set<string>(); const states = new Set<string>(); let usesStatus = false;
  const take = (word: string) => { if (ts[pos]?.type !== 'string' && ts[pos]?.value === word) { pos++; return true; } return false; };
  const expect = (word: string) => { if (!take(word)) throw new MonitorError('INVALID_CONDITION', `条件缺少 ${word}`); };
  const literal = (): Scalar => {
    const t = ts[pos++];
    if (!t) throw new MonitorError('INVALID_CONDITION', '条件缺少比较值');
    if (t.type === 'number') { const value = Number(t.value); if (!Number.isFinite(value)) throw new MonitorError('INVALID_CONDITION', '数字超出范围'); return value; }
    if (t.type === 'string') return t.value;
    if (t.type === 'word') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      if (['ok', 'unknown', 'unavailable', 'expired', 'redacted', 'partial', 'pending', 'needs_approval', 'needs_reauth', 'forbidden', 'error', 'unsupported', 'unknown_outcome'].includes(t.value)) return t.value;
    }
    throw new MonitorError('INVALID_CONDITION', '比较值必须是数字、引号字符串、布尔值或状态名');
  };
  const term = (depth: number): Node => {
    if (depth > 16) throw new MonitorError('INVALID_CONDITION', '条件嵌套过深');
    if (take('!') || take('not')) return { kind: 'not', value: term(depth + 1) };
    if (take('(')) { const result = expr(depth + 1); expect(')'); return result; }
    const t = ts[pos++];
    if (!t || t.type !== 'word') throw new MonitorError('INVALID_CONDITION', '条件左侧必须是字段、state(字段) 或 status');
    let ref: Ref;
    if (t.value === 'state') {
      expect('('); const path = ts[pos++]?.value ?? ''; expect(')');
      if (!validFieldPath(path)) throw new MonitorError('INVALID_CONDITION', '字段路径无效');
      states.add(path); ref = { kind: 'state', path };
    } else if (t.value === 'status') { usesStatus = true; ref = { kind: 'status' }; }
    else { if (!validFieldPath(t.value)) throw new MonitorError('INVALID_CONDITION', '字段路径无效'); paths.add(t.value); ref = { kind: 'field', path: t.value }; }
    const op = ts[pos++]?.value;
    if (!op || !['==', '!=', '<', '<=', '>', '>=', 'in', 'contains'].includes(op)) throw new MonitorError('INVALID_CONDITION', '条件缺少支持的比较运算符');
    let value: Scalar | Scalar[];
    if (take('[')) {
      const list: Scalar[] = [];
      if (!take(']')) { do { list.push(literal()); } while (take(',')); expect(']'); }
      if (list.length > 50) throw new MonitorError('INVALID_CONDITION', '条件列表过长'); value = list;
    } else value = literal();
    if (op === 'in' && !Array.isArray(value)) throw new MonitorError('INVALID_CONDITION', 'in 右侧需要列表');
    return { kind: 'comparison', ref, op, value };
  };
  const and = (depth: number): Node => { let left = term(depth); while (take('and')) left = { kind: 'and', left, right: term(depth) }; return left; };
  const expr = (depth: number): Node => { let left = and(depth); while (take('or')) left = { kind: 'or', left, right: and(depth) }; return left; };
  const root = expr(0);
  if (pos !== ts.length) throw new MonitorError('INVALID_CONDITION', '条件末尾有未使用的内容');
  if (mode === 'failure' && (paths.size || states.size || !usesStatus)) throw new MonitorError('INVALID_CONDITION', '查询失败规则只能判断 status');
  if (mode === 'data' && usesStatus) throw new MonitorError('INVALID_CONDITION', '数据规则只能判断字段或 state(字段)，请用独立的查询失败规则判断 status');
  return { root, paths: [...paths], states: [...states], usesStatus };
}

/** Null means indeterminate; it must never count towards recovery. */
export function evaluateCondition(compiled: CompiledCondition, envelope: ResultEnvelope, mode: 'data' | 'failure'): boolean | null {
  if (mode === 'data' && envelope.outcome === 'error') return null;
  const read = (ref: Ref): unknown => {
    if (ref.kind === 'status') return envelope.status;
    const value = fieldValue(envelope.data, ref.path);
    const state = envelope.fields[ref.path]?.status ?? (value === undefined || value === null ? 'unknown' : 'ok');
    return ref.kind === 'state' ? state : state === 'ok' ? value : undefined;
  };
  const visit = (node: Node): boolean | null => {
    if (node.kind === 'not') { const value = visit(node.value); return value === null ? null : !value; }
    if (node.kind === 'and' || node.kind === 'or') {
      const a = visit(node.left); const b = visit(node.right);
      return node.kind === 'and' ? a === false || b === false ? false : a === null || b === null ? null : true
        : a === true || b === true ? true : a === null || b === null ? null : false;
    }
    const a = read(node.ref); const b = node.value;
    if (a === undefined || (a === null && b !== null)) return null;
    switch (node.op) {
      case '==': return typeof a === typeof b ? a === b : null;
      case '!=': return typeof a === typeof b ? a !== b : null;
      case 'in': return Array.isArray(b) ? b.includes(a as Scalar) : null;
      case 'contains': return typeof a === 'string' && typeof b === 'string' ? a.includes(b) : Array.isArray(a) && !Array.isArray(b) ? a.includes(b) : null;
      default:
        if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a)) return null;
        return node.op === '<' ? a < b : node.op === '<=' ? a <= b : node.op === '>' ? a > b : a >= b;
    }
  };
  return visit(compiled.root);
}
