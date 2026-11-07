// Convert a Zod schema to a JSON Schema object, folding in x-* keywords from field().
// Uses zod-to-json-schema with the postProcess hook.

import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodType, ZodTypeDef } from 'zod';
import type { JsonSchema7Type } from 'zod-to-json-schema';
import { getFieldMetaFromDef } from './meta.js';

/**
 * Export a Zod schema as a JSON Schema draft-07 object with x-* extension
 * keywords injected from any field() annotations.
 */
export function toJSONSchema(schema: ZodType): Record<string, unknown> {
  const result = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    postProcess: (
      jsonSchema: JsonSchema7Type | undefined,
      def: ZodTypeDef,
    ): JsonSchema7Type | undefined => {
      if (!jsonSchema) return jsonSchema;
      const meta = getFieldMetaFromDef(def);
      if (!meta) return jsonSchema;

      const out = { ...jsonSchema } as Record<string, unknown>;
      if (meta.unit !== undefined) out['x-unit'] = meta.unit;
      if (meta.scope !== undefined) out['x-scope'] = meta.scope;
      if (meta.sensitivity !== undefined) out['x-sensitivity'] = meta.sensitivity;
      if (meta.untrusted) out['x-untrusted'] = true;
      if (meta.dimension !== undefined) out['x-dimension'] = meta.dimension;
      if (meta.unknownReason !== undefined) out['x-unknown-reason'] = meta.unknownReason;

      return out as JsonSchema7Type;
    },
  });

  return result as Record<string, unknown>;
}

/**
 * Walk a compiled JSON Schema and collect every property that is missing
 * the x-sensitivity and x-untrusted annotations.
 * Used in tests to enforce "all output fields must go through field()".
 */
export function findUnannotatedFields(
  schema: Record<string, unknown>,
  path = '',
): string[] {
  const missing = new Set<string>();
  const isSchema = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  function visit(current: Record<string, unknown>, at: string, ancestors: Set<object>): void {
    // The exported document is JSON, but callers may also pass an in-memory
    // schema graph. Follow each data path once without looping on graph cycles.
    if (ancestors.has(current)) return;
    const next = new Set([...ancestors, current]);
    const properties = current['properties'];
    // JSON Schema permits omitted type and nullable unions such as
    // type: ['object', 'null']; their named properties still need annotations.
    if (isSchema(properties)) for (const [key, value] of Object.entries(properties)) {
      const fieldPath = at ? `${at}.${key}` : key;
      if (!isSchema(value) || value['x-sensitivity'] === undefined && value['x-untrusted'] === undefined) missing.add(fieldPath);
      if (isSchema(value)) visit(value, fieldPath, next);
    }
    const items = current['items'];
    if (isSchema(items)) visit(items, `${at}[]`, next);
    else if (Array.isArray(items)) items.forEach((item, index) => { if (isSchema(item)) visit(item, `${at}[${index}]`, next); });
    const prefixItems = current['prefixItems'];
    if (Array.isArray(prefixItems)) prefixItems.forEach((item, index) => { if (isSchema(item)) visit(item, `${at}[${index}]`, next); });
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      const branches = current[key];
      if (Array.isArray(branches)) for (const branch of branches) if (isSchema(branch)) visit(branch, at, next);
    }
    if (isSchema(current['additionalProperties'])) visit(current['additionalProperties'], at ? `${at}.*` : '*', next);
    if (isSchema(current['additionalItems'])) visit(current['additionalItems'], `${at}[]`, next);
  }
  visit(schema, path, new Set());
  return [...missing];
}
