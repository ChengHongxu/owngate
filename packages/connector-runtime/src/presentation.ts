import type { JSONSchema, PresentationField, ResultPresentation } from '@owngate/core';

const TYPES = new Set(['auto', 'stats', 'table', 'list', 'feed', 'json']);
const FORMATS = new Set(['text', 'number', 'datetime', 'link', 'badge']);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ARRAY_VIEWS = new Set(['table', 'list', 'feed']);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function object(value: unknown, context: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${context}: expected an object`);
  return value;
}

function keys(value: Record<string, unknown>, allowed: string[], context: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${context}: unsupported property`);
}

function pathParts(value: unknown, context: string): string[] {
  if (typeof value !== 'string' || !value || value.length > 128) throw new Error(`${context}: path needs 1–128 characters`);
  if (value === '$') return [];
  const parts = value.replace(/^\$\./, '').split('.');
  if (parts.length > 8 || parts.some(part => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(part) || BAD_KEYS.has(part))) {
    throw new Error(`${context}: only static property paths are supported`);
  }
  return parts;
}

function atSchema(root: JSONSchema, path: unknown, context: string): JSONSchema {
  let current = root;
  for (const part of pathParts(path, context)) {
    const properties = current['properties'];
    if (!isObject(properties) || !Object.hasOwn(properties, part) || !isObject(properties[part])) {
      throw new Error(`${context}: path must reference a declared output field`);
    }
    current = properties[part];
  }
  return current;
}

function schemaTypes(schema: JSONSchema): unknown[] {
  const value = schema['type'];
  return Array.isArray(value) ? value.filter(type => type !== 'null') : [value];
}

function fields(value: unknown, root: JSONSchema, context: string): PresentationField[] {
  if (!Array.isArray(value) || !value.length || value.length > 12) throw new Error(`${context}: needs 1–12 fields`);
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const name = `${context}[${index}]`, field = object(raw, name);
    keys(field, ['path', 'label', 'format', 'prominent'], name);
    const schema = atSchema(root, field['path'], name);
    const path = field['path'] as string;
    const canonical = pathParts(path, name).join('.');
    if (seen.has(canonical)) throw new Error(`${name}: duplicate field binding`);
    seen.add(canonical);
    if (field['label'] !== undefined && (typeof field['label'] !== 'string' || !field['label'].trim() || field['label'].length > 80 || /[\r\n\0]/.test(field['label']))) throw new Error(`${name}: label needs 1–80 characters`);
    const format = field['format'];
    if (format !== undefined && (typeof format !== 'string' || !FORMATS.has(format))) throw new Error(`${name}: unsupported format`);
    if (field['prominent'] !== undefined && typeof field['prominent'] !== 'boolean') throw new Error(`${name}: prominent must be boolean`);
    const types = schemaTypes(schema);
    if (format === 'number' && !types.every(type => type === 'number' || type === 'integer')) throw new Error(`${name}: number format requires a numeric output`);
    if (format === 'link' && !types.every(type => type === 'string')) throw new Error(`${name}: link format requires a string output`);
    if (format === 'datetime' && !types.every(type => ['string', 'number', 'integer'].includes(String(type)))) throw new Error(`${name}: datetime format requires a string or numeric output`);
    return { path, ...(typeof field['label'] === 'string' ? { label: field['label'] } : {}),
      ...(typeof format === 'string' ? { format: format as NonNullable<PresentationField['format']> } : {}),
      ...(typeof field['prominent'] === 'boolean' ? { prominent: field['prominent'] } : {}) };
  });
}

/** Validate display metadata once at compilation. Bindings are resolved only
 * against the declared result schema, never against upstream responses. */
export function compilePresentation(value: unknown, output: JSONSchema, context = 'presentation'): ResultPresentation | undefined {
  if (value === undefined) return undefined;
  const input = object(value, context);
  keys(input, ['type', 'items', 'fields', 'columns', 'max_rows'], context);
  if (typeof input['type'] !== 'string' || !TYPES.has(input['type'])) throw new Error(`${context}: unsupported type`);
  const type = input['type'] as ResultPresentation['type'];
  const maxRows = input['max_rows'];
  if (maxRows !== undefined && (typeof maxRows !== 'number' || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 20)) throw new Error(`${context}: max_rows must be an integer from 1 to 20`);
  let itemSchema: JSONSchema | undefined;
  if (ARRAY_VIEWS.has(type)) {
    const array = atSchema(output, input['items'], `${context}.items`);
    if (!schemaTypes(array).includes('array') || !isObject(array['items'])) throw new Error(`${context}.items: binding must be an array with a declared item schema`);
    itemSchema = array['items'];
  } else if (input['items'] !== undefined) throw new Error(`${context}: items is only supported by table, list and feed`);
  if (input['fields'] !== undefined && type !== 'stats' && type !== 'list') throw new Error(`${context}: fields is only supported by stats and list`);
  if (input['columns'] !== undefined && type !== 'table') throw new Error(`${context}: columns is only supported by table`);
  const boundFields = input['fields'] === undefined ? undefined : fields(input['fields'], type === 'list' ? itemSchema! : output, `${context}.fields`);
  const boundColumns = input['columns'] === undefined ? undefined : fields(input['columns'], itemSchema!, `${context}.columns`);
  return { type, ...(ARRAY_VIEWS.has(type) ? { items: input['items'] as string } : {}),
    ...(boundFields ? { fields: boundFields } : {}), ...(boundColumns ? { columns: boundColumns } : {}),
    ...(maxRows !== undefined ? { max_rows: maxRows as number } : {}) };
}
