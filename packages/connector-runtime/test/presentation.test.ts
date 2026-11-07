import { describe, expect, it } from 'vitest';
import type { JSONSchema } from '@owngate/core';
import { loadManifest } from '../src/loader.js';
import { compilePresentation } from '../src/presentation.js';

const output: JSONSchema = {
  type: 'object',
  properties: {
    balance: { type: ['number', 'null'], title: '可用额度', 'x-unit': 'USD' },
    profile: { type: 'object', properties: { name: { type: 'string' } } },
    rows: { type: ['array', 'null'], items: { type: 'object', properties: {
      title: { type: 'string' }, amount: { type: 'integer' },
      author: { type: 'object', properties: { name: { type: 'string' } } },
      url: { type: 'string', format: 'uri' }, created_at: { type: 'string', format: 'date-time' },
    } } },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

describe('declarative result presentation', () => {
  it('keeps legacy capabilities optional and accepts explicit automatic and raw views', () => {
    expect(compilePresentation(undefined, output)).toBeUndefined();
    expect(compilePresentation({ type: 'auto' }, output)).toEqual({ type: 'auto' });
    expect(compilePresentation({ type: 'json' }, output)).toEqual({ type: 'json' });
  });

  it('binds stats to result data and returns a separate validated declaration', () => {
    const declaration = { type: 'stats', fields: [{ path: '$.balance', label: '额度', format: 'number', prominent: true }] };
    const compiled = compilePresentation(declaration, output);
    expect(compiled).toEqual(declaration);
    declaration.fields[0]!.label = 'Changed after compilation';
    expect(compiled?.fields?.[0]?.label).toBe('额度');
  });

  it('binds table columns and list fields relative to each selected array item', () => {
    const table = { type: 'table', items: '$.rows', columns: [
      { path: 'title', label: '标题' }, { path: '$.author.name', label: '作者' },
      { path: 'amount', format: 'number' }, { path: 'url', format: 'link' },
      { path: 'created_at', format: 'datetime' },
    ], max_rows: 5 };
    expect(compilePresentation(table, output)).toEqual(table);
    const list = { type: 'list', items: 'rows', fields: [{ path: 'author.name' }] };
    expect(compilePresentation(list, output)).toEqual(list);
    expect(compilePresentation({ type: 'feed', items: '$.rows', max_rows: 20 }, output)).toEqual({ type: 'feed', items: '$.rows', max_rows: 20 });
    expect(() => compilePresentation({ type: 'table', items: '$.rows', columns: [{ path: '$.rows.title' }] }, output)).toThrow(/declared output field/);
  });

  it('allows the root binding for a primitive array item and for an array result schema', () => {
    expect(compilePresentation({ type: 'list', items: '$.tags', fields: [{ path: '$' }] }, output)?.fields).toEqual([{ path: '$' }]);
    const rootArray = { type: 'array', items: { type: 'integer' } };
    expect(compilePresentation({ type: 'table', items: '$', columns: [{ path: '$', format: 'number' }] }, rootArray)?.items).toBe('$');
  });

  it.each([
    { type: 'table' },
    { type: 'list', items: '$.balance' },
    { type: 'feed', items: '$.missing' },
    { type: 'stats', items: '$.rows' },
    { type: 'feed', items: '$.rows', fields: [{ path: 'title' }] },
    { type: 'table', items: '$.rows', fields: [{ path: 'title' }] },
    { type: 'stats', columns: [{ path: 'balance' }] },
    { type: 'stats', fields: [{ path: 'profile.missing' }] },
  ])('rejects bindings outside the declared view/schema: %j', (value) => {
    expect(() => compilePresentation(value, output)).toThrow(/presentation/);
  });

  it.each([
    null, 'stats', { type: 'html' }, { type: 'stats', script: 'alert(1)' },
    { type: 'stats', fields: [] },
    { type: 'stats', fields: Array.from({ length: 13 }, () => ({ path: 'balance' })) },
    { type: 'stats', fields: [{ path: 'balance', format: 'currency' }] },
    { type: 'stats', fields: [{ path: 'balance', html: '<div />' }] },
    { type: 'stats', fields: [{ path: 'balance', prominent: 1 }] },
    { type: 'stats', fields: [{ path: 'balance', label: ' ' }] },
    { type: 'stats', fields: [{ path: 'balance', label: 'a'.repeat(81) }] },
    { type: 'stats', fields: [{ path: 'balance', label: 'line\nbreak' }] },
    ...[0, 21, 1.5, '5'].map(max_rows => ({ type: 'auto', max_rows })),
  ])('rejects invalid or executable display metadata: %j', (value) => {
    expect(() => compilePresentation(value, output)).toThrow(/presentation/);
  });

  it.each([
    '', '$.', '$..balance', '$.rows[0]', '$.rows.*', '$.rows[?(@.amount)]',
    '$.__proto__.name', 'constructor', '$.profile.prototype',
    'a.'.repeat(8) + 'a', 'a'.repeat(129),
  ])('rejects dynamic, unsafe or unbounded path %s', (path) => {
    expect(() => compilePresentation({ type: 'stats', fields: [{ path }] }, output)).toThrow(/presentation/);
  });

  it('rejects duplicate bindings regardless of the optional root prefix', () => {
    expect(() => compilePresentation({ type: 'stats', fields: [{ path: 'balance' }, { path: '$.balance' }] }, output)).toThrow(/duplicate field/);
  });

  it.each([
    { path: '$.profile.name', format: 'number' },
    { path: '$.balance', format: 'link' },
    { path: '$.profile', format: 'datetime' },
  ])('rejects a format incompatible with its output type: %j', (field) => {
    expect(() => compilePresentation({ type: 'stats', fields: [field] }, output)).toThrow(/requires/);
  });

  it('never treats additional or inherited object properties as a declared binding', () => {
    expect(() => compilePresentation({ type: 'stats', fields: [{ path: 'dynamic' }] }, { type: 'object', additionalProperties: true })).toThrow(/declared output field/);
    const inherited = { type: 'object', properties: Object.create({ balance: { type: 'number' } }) };
    expect(() => compilePresentation({ type: 'stats', fields: [{ path: 'balance' }] }, inherited)).toThrow(/declared output field/);
  });
});

describe('native presentation compilation', () => {
  function definition() {
    return {
      connector: 'display_fixture', title: 'Display fixture', version: '1.0.0', access: 'official_api',
      capabilities: [{ id: 'balance.get', title: '余额', kind: 'query', effect: 'read',
        request: { method: 'GET', path: '/balance' },
        output: { balance: { from: '$.upstream.amount', schema: { type: 'number', title: '可用额度', description: '当前额度', format: 'double', 'x-unit': 'USD' } } },
        presentation: { type: 'stats', fields: [{ path: '$.balance', format: 'number', prominent: true }] },
      }],
    };
  }

  it('compiles metadata alongside the mapped output schema without changing extraction', () => {
    const source = definition();
    const capability = loadManifest(JSON.stringify(source)).capabilities['balance.get'];
    expect(capability?.presentation).toEqual(source.capabilities[0]!.presentation);
    expect(capability?.output).toMatchObject({ properties: { balance: {
      type: 'number', title: '可用额度', description: '当前额度', format: 'double', 'x-unit': 'USD', 'x-from': '$.upstream.amount',
    } } });
  });

  it('rejects upstream paths because presentation only binds declared result names', () => {
    const source = definition(); source.capabilities[0]!.presentation.fields[0]!.path = '$.upstream.amount';
    expect(() => loadManifest(JSON.stringify(source))).toThrow(/balance.get.*presentation.*declared output field/);
  });
});
