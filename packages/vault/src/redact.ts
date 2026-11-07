// Field policy and secret scrubbing at the common output boundary.
import type { JSONSchema } from '@owngate/core';

export type SensitivityLevel = 'pii' | 'financial' | 'content';
export interface RedactionContext {
  includeContent?: boolean;
  includePii?: boolean;
  includeFinancial?: boolean;
  includeUntrusted?: boolean;
}

const SECRET_KEY = /^(?:password|passwd|secret|token|.*_token|.*_secret|api[_-]?key|authorization|cookie|set-cookie)$/i;

/** Registered credential values never leave errors, audit records or results. */
export class SecretRedactor {
  private readonly scopes = new Map<string, Set<string>>();

  register(scope: string, values: Iterable<string>): void {
    this.scopes.set(scope, new Set([...values].filter((value) => value.length > 0)));
  }

  unregister(scope: string): void { this.scopes.delete(scope); }

  redact<T>(value: T): T {
    const secrets = [...new Set([...this.scopes.values()].flatMap((values) => [...values]))]
      .sort((a, b) => b.length - a.length);
    const scrubString = (text: string): string => {
      let out = text;
      for (const secret of secrets) out = out.split(secret).join('[REDACTED]');
      return out
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
        .replace(/\badmin-[a-f\d]{64}\b/gi, '[REDACTED]')
        .replace(/\b(?:Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi, 'Cookie: [REDACTED]');
    };
    const walk = (item: unknown): unknown => {
      if (typeof item === 'string') return scrubString(item);
      if (Array.isArray(item)) return item.map(walk);
      if (typeof item === 'object' && item !== null) {
        return Object.fromEntries(Object.entries(item).map(([key, val]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : walk(val)]));
      }
      return item;
    };
    return walk(value) as T;
  }
}

export function redact(
  data: unknown,
  schema: JSONSchema,
  ctx: RedactionContext = {},
): { data: unknown; redacted: string[] } {
  const paths: string[] = [];
  return { data: redactValue(data, schema, ctx, '', paths), redacted: paths };
}

function shouldRedact(schema: JSONSchema, ctx: RedactionContext, key: string): boolean {
  // Secrets remain secret even for the administrator.
  if (SECRET_KEY.test(key) || schema['writeOnly'] === true || schema['x-secret'] === true || schema['x-sensitivity'] === 'secret') return true;
  if (ctx.includeUntrusted === false && schema['x-untrusted'] === true) return true;
  const sensitivity = schema['x-sensitivity'] ?? 'content';
  if (sensitivity === 'pii') return ctx.includePii !== true;
  if (sensitivity === 'financial') return ctx.includeFinancial === false;
  if (sensitivity === 'content') return ctx.includeContent === false;
  // An unrecognized classification must not become a way to bypass policy.
  return true;
}

function redactValue(
  value: unknown,
  schema: JSONSchema,
  ctx: RedactionContext,
  path: string,
  paths: string[],
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const props = (schema['properties'] ?? {}) as Record<string, JSONSchema>;
    const additional = schema['additionalProperties'];
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const fieldPath = path ? `${path}.${key}` : key;
      const child = props[key] ?? (typeof additional === 'object' && additional !== null ? additional as JSONSchema : undefined);
      if (!child) {
        // Dynamic output is only permitted when its value schema is explicit.
        paths.push(fieldPath);
        continue;
      }
      if (shouldRedact(child, ctx, key)) {
        paths.push(fieldPath);
        out[key] = null;
      } else {
        out[key] = redactValue(val, child, ctx, fieldPath, paths);
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    const items = schema['items'];
    if (typeof items !== 'object' || items === null || Array.isArray(items)) {
      paths.push(path);
      return null;
    }
    return value.map((item, i) => {
      const fieldPath = `${path}[${i}]`;
      if (shouldRedact(items as JSONSchema, ctx, '')) {
        paths.push(fieldPath);
        return null;
      }
      return redactValue(item, items as JSONSchema, ctx, fieldPath, paths);
    });
  }
  return value;
}
