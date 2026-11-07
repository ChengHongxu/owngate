import type { Capability, ComparisonView, JSONSchema, VerificationPlan } from '@owngate/core';

const BAD_PARTS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_VIEWS = 8;
const MAX_CHECKS = 50;
type ObjectValue = Record<string, unknown>;

function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown, context: string): ObjectValue {
  if (!isObject(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${context}: expected a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !Object.hasOwn(descriptor, 'value'))) {
    throw new Error(`${context}: only static data properties are supported`);
  }
  return value;
}

function own(value: unknown, key: string): unknown {
  if (!isObject(value) && !Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function keys(value: ObjectValue, allowed: string[], context: string): void {
  if (Object.getOwnPropertyNames(value).some(key => !allowed.includes(key))) throw new Error(`${context}: unsupported property`);
}

function text(value: unknown, max: number, context: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${context}: needs 1–${max} characters without control characters`);
  }
  return value;
}

function identifier(value: unknown, max: number, context: string): string {
  const id = text(value, max, context);
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(id) || id.split('.').some(part => BAD_PARTS.has(part))) {
    throw new Error(`${context}: invalid identifier`);
  }
  return id;
}

/** Static own-property paths only. No JSONPath, templates, indices or evaluation. */
export function parseStaticPath(value: unknown, context = 'static path'): string[] {
  const path = text(value, 128, context);
  if (path === '$') return [];
  const parts = path.replace(/^\$\./, '').split('.');
  if (parts.length > 8 || parts.some(part => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(part) || BAD_PARTS.has(part))) {
    throw new Error(`${context}: only safe static property paths of at most 8 segments are supported`);
  }
  return parts;
}

function path(value: unknown, context: string): string {
  return parseStaticPath(value, context).join('.') || '$';
}

/** Missing or inherited properties are absent; getters are never executed. */
export function readStaticPath(value: unknown, propertyPath: string): unknown {
  for (const part of parseStaticPath(propertyPath)) value = own(value, part);
  return value;
}

/** Walk declared object properties only. Callers select an array's items schema explicitly. */
export function schemaAtPath(schema: JSONSchema, propertyPath: string): JSONSchema | undefined {
  let current: unknown = schema;
  for (const part of parseStaticPath(propertyPath)) {
    current = own(own(current, 'properties'), part);
    if (!isObject(current)) return undefined;
  }
  return isObject(current) ? current : undefined;
}

function schemaTypes(schema: JSONSchema): unknown[] {
  const type = own(schema, 'type');
  return Array.isArray(type) ? type.filter(value => value !== 'null') : [type];
}

function requireType(schema: JSONSchema | undefined, allowed: string[], context: string): JSONSchema {
  if (!schema) throw new Error(`${context}: path must reference a declared schema field`);
  const types = schemaTypes(schema);
  if (!types.length || !types.every(type => typeof type === 'string' && allowed.includes(type))) {
    throw new Error(`${context}: requires ${allowed.join(' | ')} schema type`);
  }
  return schema;
}

function readCapability(value: unknown, capabilities: Record<string, Capability>, context: string): Capability {
  const id = identifier(value, 128, context);
  const capability = Object.hasOwn(capabilities, id) ? capabilities[id] : undefined;
  if (!capability || capability.kind !== 'query' || capability.effect !== 'read') {
    throw new Error(`${context}: must reference a declared read-only query capability`);
  }
  return capability;
}

function unitBinding(value: unknown, config: Record<string, unknown>, context: string): ComparisonView['source']['unit'] {
  const unit = object(value, context);
  keys(unit, ['config', 'allowed'], context);
  const configPath = path(unit['config'], `${context}.config`);
  const schema = requireType(schemaAtPath({ type: 'object', properties: config }, configPath), ['string'], `${context}.config`);
  const choices = own(schema, 'enum');
  if (!Array.isArray(choices) || !choices.length || choices.length > 64 || choices.some(choice => typeof choice !== 'string')) {
    throw new Error(`${context}.config: must reference a declared string enum configuration`);
  }
  if (!Array.isArray(unit['allowed']) || !unit['allowed'].length || unit['allowed'].length > 16) {
    throw new Error(`${context}.allowed: needs 1–16 confirmed units`);
  }
  const allowed = unit['allowed'].map((value, index) => {
    const confirmed = text(value, 32, `${context}.allowed[${index}]`);
    if (confirmed !== confirmed.trim() || confirmed.toLowerCase() === 'unknown' || !choices.includes(confirmed)) {
      throw new Error(`${context}.allowed: units must be known non-empty members of the configuration enum`);
    }
    return confirmed;
  });
  if (new Set(allowed).size !== allowed.length) throw new Error(`${context}.allowed: duplicate unit`);
  return { config: configPath, allowed };
}

/** Compile views after capabilities so every source binding is checked once. */
export function compileConnectorViews(value: unknown, capabilities: Record<string, Capability>, config: Record<string, unknown> = {}, context = 'manifest.views'): ComparisonView[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_VIEWS) throw new Error(`${context}: needs an array of at most ${MAX_VIEWS} views`);
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const name = `${context}[${index}]`, view = object(raw, name);
    keys(view, ['id', 'type', 'title', 'description', 'source', 'detail', 'target'], name);
    const id = identifier(view['id'], 64, `${name}.id`);
    if (seen.has(id)) throw new Error(`${name}: duplicate view id`);
    seen.add(id);
    if (view['type'] !== 'comparison') throw new Error(`${name}.type: only comparison is supported`);
    const title = text(view['title'], 80, `${name}.title`);
    const description = view['description'] === undefined ? undefined : text(view['description'], 1000, `${name}.description`);

    const source = object(view['source'], `${name}.source`);
    keys(source, ['capability', 'items', 'id', 'label', 'value', 'updated_at', 'updated_at_format', 'unit'], `${name}.source`);
    const sourceCapability = readCapability(source['capability'], capabilities, `${name}.source.capability`);
    const itemsPath = path(source['items'], `${name}.source.items`);
    const items = requireType(schemaAtPath(sourceCapability.output, itemsPath), ['array'], `${name}.source.items`);
    const row = own(items, 'items');
    if (!isObject(row)) throw new Error(`${name}.source.items: array needs a declared items schema`);
    const sourceId = path(source['id'], `${name}.source.id`);
    const idSchema = requireType(schemaAtPath(row, sourceId), ['integer', 'string'], `${name}.source.id`);
    const idTypes = schemaTypes(idSchema);
    if (idTypes.length !== 1) throw new Error(`${name}.source.id: requires one integer or string type`);
    const label = source['label'] === undefined ? undefined : path(source['label'], `${name}.source.label`);
    if (label !== undefined && !schemaAtPath(row, label)) throw new Error(`${name}.source.label: path must reference a declared schema field`);
    const sourceValue = path(source['value'], `${name}.source.value`);
    requireType(schemaAtPath(row, sourceValue), ['number', 'integer'], `${name}.source.value`);
    const updatedAt = path(source['updated_at'], `${name}.source.updated_at`);
    const timeFormat = source['updated_at_format'];
    if (timeFormat !== 'unix_seconds' && timeFormat !== 'iso8601') throw new Error(`${name}.source.updated_at_format: expected unix_seconds | iso8601`);
    requireType(schemaAtPath(row, updatedAt), timeFormat === 'unix_seconds' ? ['number', 'integer'] : ['string'], `${name}.source.updated_at`);
    const unit = unitBinding(source['unit'], config, `${name}.source.unit`);

    const detail = object(view['detail'], `${name}.detail`);
    keys(detail, ['capability', 'input', 'id'], `${name}.detail`);
    const detailCapability = readCapability(detail['capability'], capabilities, `${name}.detail.capability`);
    const detailInput = path(detail['input'], `${name}.detail.input`);
    if (parseStaticPath(detailInput).length !== 1) throw new Error(`${name}.detail.input: requires a single input property name`);
    const boundInput = requireType(schemaAtPath(detailCapability.input, detailInput), [String(idTypes[0])], `${name}.detail.input`);
    if (schemaTypes(boundInput).length !== 1) throw new Error(`${name}.detail.input: type must match the source row id`);
    const required = own(detailCapability.input, 'required');
    if (required !== undefined && (!Array.isArray(required) || required.some(field => typeof field !== 'string'))) {
      throw new Error(`${name}.detail.input: required input fields must be declared`);
    }
    for (const field of (required ?? []) as string[]) {
      if (field === detailInput) continue;
      const definition = own(own(detailCapability.input, 'properties'), field);
      if (!isObject(definition) || own(definition, 'default') === undefined) {
        throw new Error(`${name}.detail.input: every other required input needs a default`);
      }
    }
    const detailId = path(detail['id'], `${name}.detail.id`);
    const responseId = requireType(schemaAtPath(detailCapability.output, detailId), [String(idTypes[0])], `${name}.detail.id`);
    if (schemaTypes(responseId).length !== 1) throw new Error(`${name}.detail.id: type must match the source row id`);

    const target = object(view['target'], `${name}.target`);
    keys(target, ['capability', 'value'], `${name}.target`);
    // The target belongs to a separately selected connector. Its schema, role,
    // support state and field metadata must be checked at execution time.
    const targetCapability = identifier(target['capability'], 128, `${name}.target.capability`);
    const targetValue = path(target['value'], `${name}.target.value`);
    return { id, type: 'comparison', title, ...(description !== undefined ? { description } : {}),
      source: { capability: sourceCapability.id, items: itemsPath, id: sourceId, ...(label !== undefined ? { label } : {}), value: sourceValue,
        updated_at: updatedAt, updated_at_format: timeFormat, unit },
      detail: { capability: detailCapability.id, input: detailInput, id: detailId }, target: { capability: targetCapability, value: targetValue } };
  });
}

/** Absence retains the caller's compatibility policy; an explicit plan is data only. */
export function compileVerification(value: unknown, capabilities: Record<string, Capability>, context = 'manifest.verification'): VerificationPlan | undefined {
  if (value === undefined) return undefined;
  const plan = object(value, context);
  keys(plan, ['capabilities', 'auth'], context);
  if (!Array.isArray(plan['capabilities']) || plan['capabilities'].length > MAX_CHECKS) {
    throw new Error(`${context}.capabilities: needs an array of at most ${MAX_CHECKS} capability ids`);
  }
  const selected = plan['capabilities'].map((id, index) => readCapability(id, capabilities, `${context}.capabilities[${index}]`).id);
  if (new Set(selected).size !== selected.length) throw new Error(`${context}.capabilities: duplicate capability id`);
  const auth = plan['auth'] === undefined ? undefined : readCapability(plan['auth'], capabilities, `${context}.auth`).id;
  if (auth !== undefined && !selected.includes(auth)) throw new Error(`${context}.auth: must also be in capabilities`);
  return { capabilities: selected, ...(auth !== undefined ? { auth } : {}) };
}
