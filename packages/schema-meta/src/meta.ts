// Field metadata that attaches to Zod schemas and exports as x-* keywords.
// Design doc §3.2.1: all externally-exposed output fields MUST go through field().

export type Sensitivity = 'pii' | 'financial' | 'content';

export type FieldStatus = 'ok' | 'unknown' | 'unavailable' | 'expired' | 'redacted';

export interface FieldMeta {
  unit?: string;
  scope?: string;
  sensitivity?: Sensitivity;
  /** content from external site — auto-applied by some transforms like strip_html */
  untrusted?: boolean;
  dimension?: string;
  /** why this field may be missing */
  unknownReason?: string;
}

/** Symbol key stored directly on ZodTypeDef so postProcess can read it. */
export const META = Symbol('webridge.fieldMeta');

/**
 * Attach field metadata to a Zod schema.
 * Stores the meta on schema._def so zod-to-json-schema's postProcess hook can read it.
 */
export function field<T extends { _def: Record<symbol, unknown> }>(
  schema: T,
  meta: FieldMeta,
): T {
  schema._def[META] = meta;
  return schema;
}

/** Read back metadata from a ZodTypeDef (called inside postProcess). */
export function getFieldMetaFromDef(def: Record<symbol, unknown>): FieldMeta | undefined {
  return def[META] as FieldMeta | undefined;
}

/** Read back metadata from a Zod schema instance. */
export function getFieldMeta(schema: { _def: Record<symbol, unknown> }): FieldMeta | undefined {
  return getFieldMetaFromDef(schema._def);
}
