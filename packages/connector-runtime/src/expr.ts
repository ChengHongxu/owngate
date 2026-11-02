// Expression evaluator — design doc §4.1.2 ②
// Grammar:
//   expr    := term (('and'|'or') term)*
//   term    := comparison | '(' expr ')' | '!' term
//   comparison := ref op literal
//   op      := '==' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'contains'
//   ref     := '$' path | 'status'
//   literal := number | string | true | false | null | '[' literal,* ']'

import { pathGet } from './path.js';

export interface ExprContext {
  /** The response root (accessible as $) */
  response: unknown;
  /** HTTP status code or 'ok' for browser */
  status: number | 'ok';
}

export interface ExprResult {
  value: boolean;
  warnings: string[];
}

export function evalExpr(expr: string, ctx: ExprContext): ExprResult {
  const tokens = tokenize(expr.trim());
  const parser = new Parser(tokens, ctx);
  return parser.parseExpr();
}

// ── Tokenizer ─────────────────────────────────────────────────────────────

type Token =
  | { type: 'op'; value: '==' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'contains' }
  | { type: 'logic'; value: 'and' | 'or' }
  | { type: 'not' }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'lbracket' }
  | { type: 'rbracket' }
  | { type: 'comma' }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'bool'; value: boolean }
  | { type: 'null' }
  | { type: 'ref'; path: string } // $ path or 'status'
  | { type: 'status' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    if (/\s/.test(src[i]!)) { i++; continue; }

    // Operators (multi-char first)
    if (src.startsWith('>=', i)) { tokens.push({ type: 'op', value: '>=' }); i += 2; continue; }
    if (src.startsWith('<=', i)) { tokens.push({ type: 'op', value: '<=' }); i += 2; continue; }
    if (src.startsWith('==', i)) { tokens.push({ type: 'op', value: '==' }); i += 2; continue; }
    if (src.startsWith('!=', i)) { tokens.push({ type: 'op', value: '!=' }); i += 2; continue; }
    if (src[i] === '>') { tokens.push({ type: 'op', value: '>' }); i++; continue; }
    if (src[i] === '<') { tokens.push({ type: 'op', value: '<' }); i++; continue; }
    if (src[i] === '!') { tokens.push({ type: 'not' }); i++; continue; }
    if (src[i] === '(') { tokens.push({ type: 'lparen' }); i++; continue; }
    if (src[i] === ')') { tokens.push({ type: 'rparen' }); i++; continue; }
    if (src[i] === '[') { tokens.push({ type: 'lbracket' }); i++; continue; }
    if (src[i] === ']') { tokens.push({ type: 'rbracket' }); i++; continue; }
    if (src[i] === ',') { tokens.push({ type: 'comma' }); i++; continue; }

    // $path
    if (src[i] === '$') {
      let path = '$';
      i++;
      while (i < src.length && !/[\s(),[\]]/.test(src[i]!)) { path += src[i]; i++; }
      tokens.push({ type: 'ref', path });
      continue;
    }

    // String literals
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      i++;
      let s = '';
      while (i < src.length && src[i] !== q) { s += src[i]; i++; }
      i++; // closing quote
      tokens.push({ type: 'string', value: s });
      continue;
    }

    // Numbers
    if (/[-\d]/.test(src[i]!) && (src[i] !== '-' || /\d/.test(src[i + 1] ?? ''))) {
      let n = '';
      if (src[i] === '-') { n = '-'; i++; }
      while (i < src.length && /[\d.]/.test(src[i]!)) { n += src[i]; i++; }
      tokens.push({ type: 'number', value: parseFloat(n) });
      continue;
    }

    // Keywords and identifiers
    let word = '';
    while (i < src.length && /[a-zA-Z_]/.test(src[i]!)) { word += src[i]; i++; }
    if (word === 'and') { tokens.push({ type: 'logic', value: 'and' }); continue; }
    if (word === 'or') { tokens.push({ type: 'logic', value: 'or' }); continue; }
    if (word === 'in') { tokens.push({ type: 'op', value: 'in' }); continue; }
    if (word === 'contains') { tokens.push({ type: 'op', value: 'contains' }); continue; }
    if (word === 'true') { tokens.push({ type: 'bool', value: true }); continue; }
    if (word === 'false') { tokens.push({ type: 'bool', value: false }); continue; }
    if (word === 'null') { tokens.push({ type: 'null' }); continue; }
    if (word === 'status') { tokens.push({ type: 'status' }); continue; }
    if (word === 'not') { tokens.push({ type: 'not' }); continue; }

    throw new Error(`Unexpected character at position ${i}: "${src[i]}"`);
  }

  return tokens;
}

// ── Recursive descent parser ───────────────────────────────────────────────

class Parser {
  private pos = 0;
  private warnings: string[] = [];

  constructor(private tokens: Token[], private ctx: ExprContext) {}

  parseExpr(): ExprResult {
    let left = this.parseTerm();
    while (this.pos < this.tokens.length && this.tokens[this.pos]?.type === 'logic') {
      const logic = (this.tokens[this.pos] as { type: 'logic'; value: 'and' | 'or' }).value;
      this.pos++;
      const right = this.parseTerm();
      left = logic === 'and' ? left && right : left || right;
    }
    return { value: left, warnings: this.warnings };
  }

  private parseTerm(): boolean {
    const tok = this.tokens[this.pos];
    if (!tok) throw new Error('Unexpected end of expression');

    if (tok.type === 'not') {
      this.pos++;
      return !this.parseTerm();
    }
    if (tok.type === 'lparen') {
      this.pos++;
      const result = this.parseExpr();
      if (this.tokens[this.pos]?.type !== 'rparen') throw new Error('Expected )');
      this.pos++;
      return result.value;
    }
    return this.parseComparison();
  }

  private parseComparison(): boolean {
    const left = this.parseRef();
    const opTok = this.tokens[this.pos];
    if (!opTok || opTok.type !== 'op') {
      // bare boolean ref
      return Boolean(left);
    }
    const op = (opTok as { type: 'op'; value: string }).value;
    this.pos++;
    const right = this.parseLiteral();

    switch (op) {
      case '==': return this.safeCompare(left, right, '==');
      case '!=': return this.safeCompare(left, right, '!=');
      case '>': return this.safeCompare(left, right, '>');
      case '>=': return this.safeCompare(left, right, '>=');
      case '<': return this.safeCompare(left, right, '<');
      case '<=': return this.safeCompare(left, right, '<=');
      case 'in': {
        if (!Array.isArray(right)) { this.warnings.push(`'in' requires array on right`); return false; }
        return right.includes(left);
      }
      case 'contains': {
        if (!Array.isArray(left)) { this.warnings.push(`'contains' requires array on left`); return false; }
        return left.includes(right);
      }
      default: return false;
    }
  }

  private safeCompare(a: unknown, b: unknown, op: string): boolean {
    if (op === '==' || op === '!=') {
      const eq = a === b;
      return op === '==' ? eq : !eq;
    }
    if (typeof a !== typeof b) {
      this.warnings.push(`Type mismatch in comparison: ${typeof a} ${op} ${typeof b}`);
      return false;
    }
    if (typeof a === 'number' && typeof b === 'number') {
      if (op === '>') return a > b;
      if (op === '>=') return a >= b;
      if (op === '<') return a < b;
      if (op === '<=') return a <= b;
    }
    this.warnings.push(`Operator ${op} not applicable to ${typeof a}`);
    return false;
  }

  private parseRef(): unknown {
    const tok = this.tokens[this.pos];
    if (!tok) throw new Error('Expected reference');
    if (tok.type === 'ref') {
      this.pos++;
      return pathGet(this.ctx.response, tok.path);
    }
    if (tok.type === 'status') {
      this.pos++;
      return this.ctx.status;
    }
    // literal as left side of comparison
    return this.parseLiteral();
  }

  private parseLiteral(): unknown {
    const tok = this.tokens[this.pos];
    if (!tok) throw new Error('Expected literal');
    if (tok.type === 'string') { this.pos++; return tok.value; }
    if (tok.type === 'number') { this.pos++; return tok.value; }
    if (tok.type === 'bool') { this.pos++; return tok.value; }
    if (tok.type === 'null') { this.pos++; return null; }
    if (tok.type === 'lbracket') {
      this.pos++;
      const arr: unknown[] = [];
      while (this.tokens[this.pos]?.type !== 'rbracket') {
        arr.push(this.parseLiteral());
        if (this.tokens[this.pos]?.type === 'comma') this.pos++;
      }
      this.pos++; // skip ]
      return arr;
    }
    // Could be a ref used as literal (e.g. status on right side)
    if (tok.type === 'status') { this.pos++; return this.ctx.status; }
    if (tok.type === 'ref') { this.pos++; return pathGet(this.ctx.response, tok.path); }
    throw new Error(`Expected literal, got ${tok.type}`);
  }
}
