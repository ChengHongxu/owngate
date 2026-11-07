import type { JSONSchema } from '@owngate/core';

/** Whitelist the declared nested shape before validation; never pass API extras. */
export function projectOutput(value: unknown, schema: JSONSchema): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    const items = schema['items'];
    if (typeof items !== 'object' || items === null || Array.isArray(items)) return null;
    return value.map((item) => projectOutput(item, items as JSONSchema));
  }
  if (typeof value === 'object') {
    const properties = schema['properties'] as Record<string, JSONSchema> | undefined;
    if (!properties) return {};
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(properties)
      .filter(([key]) => Object.hasOwn(source, key) && !['__proto__', 'constructor', 'prototype'].includes(key))
      .map(([key, definition]) => [key, projectOutput(source[key], definition)]));
  }
  return value;
}

/** HTTP templates may use optional schema defaults without mutating caller data. */
export function defaultInput(value: unknown, schema: JSONSchema): Record<string, unknown> {
  const input = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const properties = schema['properties'] as Record<string, JSONSchema> | undefined;
  return { ...Object.fromEntries(Object.entries(properties ?? {}).filter(([, def]) => def['default'] !== undefined).map(([key, def]) => [key, structuredClone(def['default'])])), ...input };
}
