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
      const meta = getFieldMetaFromDef(def as Record<symbol, unknown>);
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
  const missing: string[] = [];

  if (schema['type'] === 'object' && schema['properties']) {
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    for (const [key, prop] of Object.entries(props)) {
      const fieldPath = path ? `${path}.${key}` : key;
      if (prop['x-sensitivity'] === undefined && prop['x-untrusted'] === undefined) {
        missing.push(fieldPath);
      }
      if (prop['type'] === 'object') {
        missing.push(...findUnannotatedFields(prop, fieldPath));
      }
    }
  }

  return missing;
}
