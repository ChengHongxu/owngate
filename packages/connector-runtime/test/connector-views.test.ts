import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Capability, ComparisonView, JSONSchema } from '@owngate/core';
import { loadManifest } from '../src/loader.js';
import { compileExtension } from '../src/openapi.js';
import { compileConnectorViews, compileVerification, parseStaticPath, readStaticPath, schemaAtPath } from '../src/connector-views.js';

const recordSchema = (properties: Record<string, unknown>): JSONSchema => ({ type: 'object', properties, additionalProperties: false });

function declaration(): ComparisonView {
  return {
    id: 'stock-audit', type: 'comparison', title: '库存与供应量', description: '按明确选择的供应连接核对数量。',
    source: { capability: 'inventory.snapshot', items: '$.warehouse.entries', id: 'record.sku', label: 'title', value: 'measure.quantity',
      updated_at: 'measure.checked', updated_at_format: 'unix_seconds', unit: { config: 'measurement_unit', allowed: ['items'] } },
    detail: { capability: 'inventory.record', input: 'reference', id: 'record.sku' },
    target: { capability: 'supplies.available', value: '$.availability.total' },
  };
}

function fixture(idType: 'integer' | 'string' = 'integer', timeType: 'integer' | 'string' = 'integer') {
  return {
    connector: 'inventory_fixture', version: '1.0.0', title: 'Inventory fixture', access: 'official_api',
    http: { base: 'https://fixture.invalid' },
    config: { measurement_unit: { type: 'string', enum: ['unknown', 'items', 'USD'], default: 'unknown' } },
    capabilities: [
      { id: 'inventory.snapshot', title: '库存快照', kind: 'query', effect: 'read', request: { method: 'GET', path: '/inventory' },
        input: recordSchema({}), output: { warehouse: { from: '$.warehouse', schema: recordSchema({
          entries: { type: ['array', 'null'], items: recordSchema({ record: recordSchema({ sku: { type: [idType, 'null'] } }), title: { type: 'string' },
            measure: recordSchema({ quantity: { type: ['number', 'null'] }, checked: { type: [timeType, 'null'] } }) }) },
        }) } } },
      { id: 'inventory.record', title: '库存条目', kind: 'query', effect: 'read', request: { method: 'GET', path: '/inventory/{{input.reference}}' },
        input: { ...recordSchema({ reference: { type: idType }, region: { type: 'string', default: 'zone-a' } }), required: ['reference', 'region'] },
        output: { record: { from: '$.record', schema: recordSchema({ sku: { type: [idType, 'null'] } }) } } },
    ],
  };
}

function compiled() { return loadManifest(JSON.stringify(fixture())); }
function compileView(view: unknown = declaration(), capabilities = compiled().capabilities, config: Record<string, unknown> = fixture().config) {
  return compileConnectorViews([view], capabilities, config);
}
function hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function openApiDocument() {
  const native = fixture();
  const sourceSchema = native.capabilities[0]!.output.warehouse!.schema;
  const detailSchema = native.capabilities[1]!.output.record!.schema;
  const response = (schema: JSONSchema) => ({ '200': { content: { 'application/json': { schema } } } });
  return {
    openapi: '3.0.3', info: { title: 'Inventory OpenAPI', version: '1.0.0' }, servers: [{ url: 'https://fixture.invalid/v1' }],
    paths: {
      '/inventory': { get: { operationId: 'inventory.snapshot', responses: response(recordSchema({ warehouse: sourceSchema })) } },
      '/inventory/{reference}': { get: { operationId: 'inventory.record', parameters: [{ in: 'path', name: 'reference', required: true, schema: { type: 'integer' } }],
        responses: response(recordSchema({ record: detailSchema })) } },
    },
  };
}
function sourceRows(capabilities: Record<string, Capability>): Record<string, JSONSchema> {
  const rows = schemaAtPath(capabilities['inventory.snapshot']!.output, 'warehouse.entries')!;
  return ((rows['items'] as JSONSchema)['properties']) as Record<string, JSONSchema>;
}

describe('static connector view paths', () => {
  it('normalizes root prefixes and only reads own data properties', () => {
    expect(parseStaticPath('$.warehouse.entries')).toEqual(['warehouse', 'entries']);
    expect(parseStaticPath('$')).toEqual([]);
    expect(readStaticPath({ warehouse: { quantity: 0, enabled: false } }, 'warehouse.quantity')).toBe(0);
    expect(readStaticPath({ warehouse: { quantity: 0, enabled: false } }, '$.warehouse.enabled')).toBe(false);
    const inherited = Object.create({ warehouse: { quantity: 100 } });
    expect(readStaticPath(inherited, 'warehouse.quantity')).toBeUndefined();
    let accessed = false;
    const getter = Object.defineProperty({}, 'warehouse', { get: () => { accessed = true; return {}; } });
    expect(readStaticPath(getter, 'warehouse.quantity')).toBeUndefined();
    expect(accessed).toBe(false);
    const value = { quantity: 0 };
    expect(readStaticPath(value, '$')).toBe(value);
  });

  it('walks declared schemas without following arrays or inherited properties', () => {
    const schema = compiled().capabilities['inventory.snapshot']!.output;
    expect(schemaAtPath(schema, 'warehouse.entries')).toMatchObject({ type: ['array', 'null'] });
    expect(schemaAtPath(schema, 'warehouse.entries.record.sku')).toBeUndefined();
    expect(schemaAtPath(schema, 'warehouse.missing')).toBeUndefined();
    expect(schemaAtPath({ type: 'object', properties: Object.create({ amount: { type: 'number' } }) }, 'amount')).toBeUndefined();
    expect(schemaAtPath(schema, '$')).toBe(schema);
  });

  it.each(['', '$.', '$..quantity', 'warehouse[0]', 'warehouse.*', 'warehouse[?(@.x)]', '{{config.unit}}',
    'javascript:alert(1)', '__proto__.quantity', 'warehouse.constructor', 'prototype', 'warehouse\n.quantity',
    'a.'.repeat(8) + 'a', 'a'.repeat(129)])('rejects unsafe, executable or unbounded path %s', propertyPath => {
    expect(() => parseStaticPath(propertyPath)).toThrow(/static path/);
    expect(() => readStaticPath({}, propertyPath)).toThrow(/static path/);
    expect(() => schemaAtPath({}, propertyPath)).toThrow(/static path/);
  });
});

describe('connector comparison view compilation', () => {
  it('keeps legacy declarations absent and explicit empty declarations distinct', () => {
    expect(compiled().views).toBeUndefined(); expect(compiled().verification).toBeUndefined();
    expect(compileConnectorViews(undefined, {})).toBeUndefined(); expect(compileConnectorViews([], {})).toEqual([]);
    expect(compileVerification(undefined, {})).toBeUndefined(); expect(compileVerification({ capabilities: [] }, {})).toEqual({ capabilities: [] });
  });

  it('compiles a non-New-API workflow with custom capability ids, nested fields and cross-connector targets', () => {
    const source = { ...fixture(), views: [declaration()], verification: { capabilities: ['inventory.snapshot'], auth: 'inventory.snapshot' } };
    const result = loadManifest(JSON.stringify(source));
    expect(result.views).toEqual([{ ...declaration(), source: { ...declaration().source, items: 'warehouse.entries' }, target: { capability: 'supplies.available', value: 'availability.total' } }]);
    expect(result.verification).toEqual(source.verification);
    expect(result.capabilities['supplies.available']).toBeUndefined();
    source.views[0]!.source.unit.allowed[0] = 'USD';
    expect(result.views?.[0]?.source.unit.allowed).toEqual(['items']);
  });

  it('accepts string ids, ISO time fields, nullable types and required inputs with defaults', () => {
    const capabilities = loadManifest(JSON.stringify(fixture('string', 'string'))).capabilities;
    const view = declaration(); view.source.updated_at_format = 'iso8601';
    expect(compileView(view, capabilities)?.[0]?.detail.input).toBe('reference');
  });

  it('does not treat a view as an authorization or remove it when draft capabilities are disabled', () => {
    const capabilities = compiled().capabilities;
    for (const capability of Object.values(capabilities)) { capability.roles = ['admin']; capability.support = { status: 'disabled' }; }
    expect(compileView(declaration(), capabilities)).toHaveLength(1);
    expect(capabilities['inventory.snapshot']!.support.status).toBe('disabled');
  });

  it.each([
    ['unknown view property', (view: ComparisonView) => Object.assign(view, { script: 'return 1' })],
    ['unknown source property', (view: ComparisonView) => Object.assign(view.source, { url: 'https://fixture.invalid' })],
    ['unknown detail property', (view: ComparisonView) => Object.assign(view.detail, { code: 'return 1' })],
    ['unknown target property', (view: ComparisonView) => Object.assign(view.target, { html: '<script>1</script>' })],
    ['unknown unit property', (view: ComparisonView) => Object.assign(view.source.unit, { transform: 'USD(value)' })],
    ['script view type', (view: ComparisonView) => Object.assign(view, { type: 'javascript' })],
    ['long id', (view: ComparisonView) => { view.id = 'a'.repeat(65); }],
    ['prototype id', (view: ComparisonView) => { view.id = 'constructor'; }],
    ['long title', (view: ComparisonView) => { view.title = 'a'.repeat(81); }],
    ['blank title', (view: ComparisonView) => { view.title = ' '; }],
    ['long description', (view: ComparisonView) => { view.description = 'a'.repeat(1001); }],
    ['unsafe source path', (view: ComparisonView) => { view.source.id = 'record.__proto__'; }],
    ['unsafe target path', (view: ComparisonView) => { view.target.value = 'result[0].amount'; }],
    ['script target capability', (view: ComparisonView) => { view.target.capability = 'javascript:alert(1)'; }],
    ['long target capability', (view: ComparisonView) => { view.target.capability = 'a'.repeat(129); }],
    ['nested detail input', (view: ComparisonView) => { view.detail.input = 'record.reference'; }],
    ['missing label', (view: ComparisonView) => { view.source.label = 'missing'; }],
    ['nonarray collection', (view: ComparisonView) => { view.source.items = 'warehouse'; }],
    ['missing collection', (view: ComparisonView) => { view.source.items = 'missing'; }],
    ['missing source id', (view: ComparisonView) => { view.source.id = 'missing'; }],
    ['missing source value', (view: ComparisonView) => { view.source.value = 'missing'; }],
    ['non-numeric source value', (view: ComparisonView) => { view.source.value = 'title'; }],
    ['wrong timestamp type', (view: ComparisonView) => { view.source.updated_at_format = 'iso8601'; }],
    ['unknown timestamp format', (view: ComparisonView) => Object.assign(view.source, { updated_at_format: 'local_date' })],
    ['missing detail id', (view: ComparisonView) => { view.detail.id = 'missing'; }],
    ['missing detail input', (view: ComparisonView) => { view.detail.input = 'missing'; }],
    ['unknown source capability', (view: ComparisonView) => { view.source.capability = 'unknown.read'; }],
    ['unknown detail capability', (view: ComparisonView) => { view.detail.capability = 'unknown.read'; }],
    ['unknown config', (view: ComparisonView) => { view.source.unit.config = 'missing'; }],
    ['unknown unit', (view: ComparisonView) => { view.source.unit.allowed = ['unknown']; }],
    ['undeclared unit', (view: ComparisonView) => { view.source.unit.allowed = ['EUR']; }],
    ['empty unit', (view: ComparisonView) => { view.source.unit.allowed = ['']; }],
    ['duplicate unit', (view: ComparisonView) => { view.source.unit.allowed = ['items', 'items']; }],
  ])('rejects %s', (_label, change) => {
    const view = declaration(); change(view);
    expect(() => compileView(view)).toThrow(/manifest.views/);
  });

  it.each(['inventory.snapshot', 'inventory.record'])('requires a read-only query for %s', capabilityId => {
    for (const mutation of [{ kind: 'action' }, { effect: 'write' }]) {
      const capabilities = compiled().capabilities; Object.assign(capabilities[capabilityId]!, mutation);
      expect(() => compileView(declaration(), capabilities)).toThrow(/read-only query/);
    }
  });

  it('requires matching source, detail input and response id types', () => {
    const capabilities = compiled().capabilities;
    const input = (capabilities['inventory.record']!.input['properties'] as Record<string, JSONSchema>);
    input['reference'] = { type: 'string' };
    expect(() => compileView(declaration(), capabilities)).toThrow(/detail.input/);
    input['reference'] = { type: 'integer' };
    const detailRecord = schemaAtPath(capabilities['inventory.record']!.output, 'record')!;
    (detailRecord['properties'] as Record<string, JSONSchema>)['sku'] = { type: 'string' };
    expect(() => compileView(declaration(), capabilities)).toThrow(/detail.id/);
    const source = compiled().capabilities;
    (sourceRows(source)['record']!['properties'] as Record<string, JSONSchema>)['sku'] = { type: 'number' };
    expect(() => compileView(declaration(), source)).toThrow(/source.id/);
  });

  it('requires a usable default for every other required detail input', () => {
    const capabilities = compiled().capabilities;
    const properties = capabilities['inventory.record']!.input['properties'] as Record<string, JSONSchema>;
    delete properties['region']!['default'];
    expect(() => compileView(declaration(), capabilities)).toThrow(/other required input needs a default/);
  });

  it('requires declared array items and a string enum unit configuration', () => {
    const capabilities = compiled().capabilities;
    delete schemaAtPath(capabilities['inventory.snapshot']!.output, 'warehouse.entries')!['items'];
    expect(() => compileView(declaration(), capabilities)).toThrow(/items schema/);
    for (const config of [{ measurement_unit: { type: 'string' } }, { measurement_unit: { type: 'integer', enum: [1] } }]) {
      expect(() => compileView(declaration(), compiled().capabilities, config)).toThrow(/unit.config/);
    }
  });

  it('bounds collections, rejects duplicate ids and never invokes declaration getters', () => {
    expect(() => compileConnectorViews(Array.from({ length: 9 }, (_, index) => ({ ...declaration(), id: `view-${index}` })), compiled().capabilities, fixture().config)).toThrow(/at most 8/);
    expect(() => compileConnectorViews([declaration(), declaration()], compiled().capabilities, fixture().config)).toThrow(/duplicate view/);
    expect(() => compileConnectorViews(null, {})).toThrow(/array/);
    let accessed = false;
    const view = declaration(); Object.defineProperty(view, 'title', { get: () => { accessed = true; return 'unsafe'; } });
    expect(() => compileView(view)).toThrow(/static data/); expect(accessed).toBe(false);
    const inherited = Object.create(declaration());
    expect(() => compileView(inherited)).toThrow(/plain object/);
  });
});

describe('explicit verification plans', () => {
  it('validates declared read-only queries and keeps the authentication check inside the plan', () => {
    const capabilities = compiled().capabilities;
    expect(compileVerification({ capabilities: ['inventory.snapshot', 'inventory.record'], auth: 'inventory.snapshot' }, capabilities))
      .toEqual({ capabilities: ['inventory.snapshot', 'inventory.record'], auth: 'inventory.snapshot' });
    expect(() => compileVerification({ capabilities: ['inventory.snapshot'], auth: 'inventory.record' }, capabilities)).toThrow(/must also be in/);
    expect(() => compileVerification({ capabilities: ['inventory.snapshot', 'inventory.snapshot'] }, capabilities)).toThrow(/duplicate/);
    expect(() => compileVerification({ capabilities: ['missing'] }, capabilities)).toThrow(/declared read-only/);
    expect(() => compileVerification({ capabilities: ['inventory.snapshot'], script: 'return 1' }, capabilities)).toThrow(/unsupported/);
    capabilities['inventory.snapshot']!.effect = 'write';
    expect(() => compileVerification({ capabilities: ['inventory.snapshot'] }, capabilities)).toThrow(/read-only/);
  });

  it('bounds and validates malformed plans', () => {
    for (const value of [null, [], {}, { capabilities: 'inventory.snapshot' }, { capabilities: Array(51).fill('inventory.snapshot') }, { capabilities: [], auth: 'javascript:alert(1)' }]) {
      expect(() => compileVerification(value, compiled().capabilities)).toThrow(/manifest.verification/);
    }
  });
});

describe('connector view extension persistence', () => {
  it('persists normalized native declarations and restores the same fingerprint without enabling draft capabilities', () => {
    const source = { ...fixture(), views: [declaration()], verification: { capabilities: ['inventory.snapshot'], auth: 'inventory.snapshot' } };
    const draft = compileExtension(JSON.stringify(source), 'manifest');
    expect(draft.manifest['views']).toEqual(draft.compiled.views);
    expect(draft.manifest['verification']).toEqual(draft.compiled.verification);
    expect(draft.compiled.views?.[0]?.source.items).toBe('warehouse.entries');
    expect(Object.values(draft.compiled.capabilities).every(capability => capability.support.status === 'disabled')).toBe(true);
    const restored = compileExtension(JSON.stringify(draft.manifest), 'manifest');
    expect(hash(restored.manifest)).toBe(hash(draft.manifest));
    const changed = { ...source, views: [{ ...declaration(), title: '另一种标题' }] };
    expect(hash(compileExtension(JSON.stringify(changed), 'manifest').manifest)).not.toBe(hash(draft.manifest));
  });

  it('applies the same view and verification validation to imported native declarations', () => {
    const invalid = declaration(); invalid.source.unit.allowed = ['unknown'];
    expect(() => compileExtension(JSON.stringify({ ...fixture(), views: [invalid] }), 'manifest')).toThrow(/units must be known/);
    expect(() => compileExtension(JSON.stringify({ ...fixture(), verification: { capabilities: ['missing'] } }), 'manifest')).toThrow(/read-only query/);
  });

  it('leaves optional metadata out of legacy normalized manifests', () => {
    const draft = compileExtension(JSON.stringify(fixture()), 'manifest');
    expect(Object.hasOwn(draft.manifest, 'views')).toBe(false); expect(Object.hasOwn(draft.manifest, 'verification')).toBe(false);
    const restored = compileExtension(JSON.stringify(draft.manifest), 'manifest');
    expect(hash(restored.manifest)).toBe(hash(draft.manifest));
  });

  it('preserves the existing native and OpenAPI fingerprints when no new declarations are present', () => {
    const native = { connector: 'legacy_fixture', version: '1.0.0', title: 'Legacy', access: 'official_api', http: { base: 'https://fixture.invalid' },
      capabilities: [{ id: 'amount.get', title: 'Amount', kind: 'query', effect: 'read', request: { method: 'GET', path: '/amount' }, output: { amount: { from: '$.amount', type: 'number' } } }] };
    const openapi = { openapi: '3.0.3', info: { title: 'Legacy', version: '1.0.0' }, servers: [{ url: 'https://fixture.invalid' }], paths: {
      '/amount': { get: { operationId: 'amount.get', responses: { '200': { content: { 'application/json': { schema: recordSchema({ amount: { type: 'number' } }) } } } } } },
    } };
    expect(hash(compileExtension(JSON.stringify(native), 'manifest', 'legacy_fixture').manifest)).toBe('bc4e5ffe2fe97959f962ed95ed6747de311611b7a98eb849b413fae926009cb9');
    expect(hash(compileExtension(JSON.stringify(openapi), 'openapi', 'legacy_fixture').manifest)).toBe('c5a61c419740a10bf9ef86fbf2bc399525d85e5c8adeeeee4d18e685454f1b94');
  });

  it('imports OpenAPI view, verification and non-secret enum configuration declarations through the same compiler', () => {
    const view = declaration(); view.source.items = '$.result.warehouse.entries';
    view.detail.input = 'path_reference'; view.detail.id = '$.result.record.sku';
    const source = { ...openApiDocument(), 'x-owngate-config': fixture().config, 'x-owngate-views': [view],
      'x-owngate-verification': { capabilities: ['inventory.snapshot'], auth: 'inventory.snapshot' } };
    const draft = compileExtension(JSON.stringify(source), 'openapi', 'openapi_inventory');
    expect(draft.compiled.views?.[0]).toMatchObject({ source: { items: 'result.warehouse.entries' }, detail: { input: 'path_reference', id: 'result.record.sku' } });
    expect(draft.compiled.verification).toEqual(source['x-owngate-verification']);
    expect(draft.manifest['views']).toEqual(draft.compiled.views);
    expect(draft.manifest['verification']).toEqual(draft.compiled.verification);
    const restored = compileExtension(JSON.stringify(draft.manifest), 'manifest');
    expect(restored.compiled.views).toEqual(draft.compiled.views);
    expect(hash(restored.manifest)).toBe(hash(draft.manifest));
    view.target.value = 'constructor.value';
    expect(() => compileExtension(JSON.stringify(source), 'openapi', 'openapi_inventory')).toThrow(/safe static property/);
  });

  it('cannot override generated OpenAPI origins or import secret or composite configuration fields', () => {
    for (const config of [{ base_url: { type: 'string', default: 'https://another.invalid' } },
      { access_token: { type: 'string' } }, { unit: { type: 'string', secret: true } }, { units: { type: 'array', items: { type: 'string' } } }]) {
      expect(() => compileExtension(JSON.stringify({ ...openApiDocument(), 'x-owngate-config': config }), 'openapi', 'openapi_inventory')).toThrow(/base_url|秘密|单值/);
    }
    const legacy = compileExtension(JSON.stringify(openApiDocument()), 'openapi', 'openapi_inventory');
    expect(Object.keys(legacy.compiled.config ?? {})).toEqual(['base_url']);
    expect(Object.hasOwn(legacy.manifest, 'views')).toBe(false); expect(Object.hasOwn(legacy.manifest, 'verification')).toBe(false);
  });
});
