import { describe, expect, it } from 'vitest';
import { compileExtension, parseExtensionSource } from '../src/openapi.js';

function document() {
  return {
    openapi: '3.0.3', info: { title: 'Fixture service', version: '1.2.0' }, servers: [{ url: 'https://fixture.invalid/api' }],
    security: [{ bearer: [] }], components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: { Result: { type: 'object', properties: { code: { type: 'integer' }, amount: { type: 'number', 'x-unit': 'USD' } }, required: ['code'] } },
    },
    paths: { '/accounts/{id}': { get: { operationId: 'account.get', summary: 'Account', parameters: [
      { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
      { in: 'query', name: 'page', schema: { type: 'integer', default: 1, minimum: 1 } },
    ], responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Result' } } } } } } } },
  };
}
function manifest() {
  return {
    connector: 'fixture_extension', version: '1.0.0', title: 'Fixture', access: 'official_api',
    config: { base_url: { type: 'string', default: 'https://fixture.invalid' } }, http: { base: '{{config.base_url}}' },
    capabilities: [{ id: 'account.get', title: 'Account', description: '', kind: 'query', effect: 'read',
      request: { method: 'GET', path: '/account' }, output: { amount: { from: '$.amount', type: 'number' } } }],
  };
}
function protocolDeclarations() {
  return {
    config: { region: { type: 'string', label: '区域', enum: ['east', 'west'], default: 'east' } },
    views: [],
    verification: { capabilities: ['account.get'], auth: 'account.get' },
    presentation: { type: 'stats', fields: [{ path: '$.result.amount', label: '额度', format: 'number' }] },
  };
}

describe('extension compilation', () => {
  it('expands local schemas and maps scalar path/query inputs while every preview capability stays disabled', () => {
    const draft = compileExtension(JSON.stringify(document()), 'openapi', 'fixture_extension');
    expect(draft.id).toBe('fixture_extension'); expect(draft.operations[0]?.eligible).toBe(true);
    expect(draft.compiled.http?.headers).toEqual({ Authorization: 'Bearer {{secret.access_token}}' });
    expect(draft.compiled.capabilityDefs?.['account.get']?.request).toEqual({ method: 'GET', path: '/api/accounts/{{input.path_id}}', query: { query_page: 'page' } });
    expect(draft.compiled.capabilities['account.get']?.input).toMatchObject({ required: ['path_id'], properties: { query_page: { type: 'integer', default: 1 } } });
    expect(draft.compiled.capabilities['account.get']?.support.status).toBe('disabled');
    expect(draft.compiled.capabilities['account.get']?.output).toMatchObject({ properties: { result: { properties: { code: { type: 'integer' }, amount: { 'x-unit': 'USD' } } } } });
  });
  it('accepts native YAML and ordinary response fields called code or script', () => {
    const draft = compileExtension(`connector: yaml_fixture
version: 1.0.0
title: YAML fixture
access: official_api
http: { base: 'https://fixture.invalid' }
capabilities:
  - id: read.get
    title: Read
    kind: query
    effect: read
    request: { method: GET, path: /read }
    output:
      code: { from: $.code, type: integer }
      script: { from: $.script, type: string }
`, 'manifest');
    expect(draft.operations[0]?.eligible).toBe(true);
  });
  it('keeps response-level privacy metadata rather than replacing it with a generic content classification', () => {
    const source = document(); Object.assign(source.components.schemas.Result, { 'x-sensitivity': 'pii', 'x-untrusted': true });
    const draft = compileExtension(JSON.stringify(source), 'openapi', 'fixture_extension');
    const result = (draft.compiled.capabilities['account.get']?.output['properties'] as Record<string, Record<string, unknown>>)['result'];
    expect(result?.['x-sensitivity']).toBe('pii'); expect(result?.['x-untrusted']).toBe(true);
  });
  it('maps OpenAPI presentation to the wrapped result schema and retains display metadata', () => {
    const source = document();
    Object.assign(source.components.schemas.Result.properties.amount, { title: '可用额度', description: '当前额度', format: 'double' });
    const presentation = { type: 'stats', fields: [{ path: '$.result.amount', label: '可用额度', format: 'number', prominent: true }] };
    Object.assign(source.paths['/accounts/{id}'].get, { 'x-owngate-presentation': presentation });
    const draft = compileExtension(JSON.stringify(source), 'openapi', 'fixture_extension');
    expect(draft.compiled.capabilities['account.get']?.presentation).toEqual(presentation);
    expect(draft.compiled.capabilities['account.get']?.output).toMatchObject({ properties: { result: { properties: {
      amount: { title: '可用额度', description: '当前额度', format: 'double', 'x-unit': 'USD' },
    } } } });
    const restored = compileExtension(JSON.stringify(draft.manifest), 'manifest');
    expect(restored.compiled.capabilities['account.get']?.presentation).toEqual(presentation);
    Object.assign(source.paths['/accounts/{id}'].get, { 'x-owngate-presentation': { type: 'stats', fields: [{ path: '$.amount' }] } });
    expect(() => compileExtension(JSON.stringify(source), 'openapi', 'fixture_extension')).toThrow(/presentation.*declared output field/);
  });
  it('imports all x-owngate declarations without losing configuration, views, verification or presentation', () => {
    const source = document(), declarations = protocolDeclarations();
    for (const name of ['config', 'views', 'verification'] as const) Object.assign(source, { [`x-owngate-${name}`]: declarations[name] });
    Object.assign(source.paths['/accounts/{id}'].get, { 'x-owngate-presentation': declarations.presentation });
    const draft = compileExtension(JSON.stringify(source), 'openapi', 'fixture_extension');
    expect(draft.compiled.config).toMatchObject(declarations.config);
    expect(draft.compiled.views).toEqual([]);
    expect(draft.compiled.verification).toEqual(declarations.verification);
    expect(draft.compiled.capabilities['account.get']?.presentation).toEqual(declarations.presentation);
    const restored = compileExtension(JSON.stringify(draft.manifest), 'manifest');
    expect(restored.manifest).toEqual(draft.manifest);
  });
  it('applies the same strict presentation validator to native extensions', () => {
    const source = manifest();
    Object.assign(source.capabilities[0]!, { presentation: { type: 'stats', fields: [{ path: 'amount', format: 'number' }] } });
    expect(compileExtension(JSON.stringify(source), 'manifest').compiled.capabilities['account.get']?.presentation?.fields).toEqual([{ path: 'amount', format: 'number' }]);
    Object.assign(source.capabilities[0]!, { presentation: { type: 'table', items: 'amount' } });
    expect(() => compileExtension(JSON.stringify(source), 'manifest')).toThrow(/presentation.items.*array/);
  });
  it('keeps POST and write-like GET operations disabled even when their source calls them queries', () => {
    for (const [method, path, id] of [['POST', '/accounts', 'create'], ['GET', '/accounts/update_balance', 'balance'], ['GET', '/accounts', 'resetPassword']]) {
      const source = manifest(); Object.assign(source.capabilities[0]!, { id, request: { method, path } });
      const draft = compileExtension(JSON.stringify(source), 'manifest');
      expect(draft.operations[0]?.eligible).toBe(false); expect(draft.compiled.capabilities[id!]?.support.status).toBe('disabled');
    }
  });
  it('keeps unknown browser adapters disabled rather than making them executable after import', () => {
    const source = { ...manifest(), access: 'browser' };
    const draft = compileExtension(JSON.stringify(source), 'manifest');
    expect(draft.operations[0]?.eligible).toBe(false); expect(draft.operations[0]?.reason).toContain('needs_adapter');
  });
  it('does not offer object query parameters or missing outputs as enabled reads', () => {
    const source = manifest(); Object.assign(source.capabilities[0]!, {
      input: { type: 'object', properties: { filter: { type: 'object', properties: { active: { type: 'boolean' } } } } },
      request: { method: 'GET', path: '/account', query: { filter: 'filter' } },
    });
    expect(compileExtension(JSON.stringify(source), 'manifest').operations[0]?.eligible).toBe(false);
    const empty = manifest(); Object.assign(empty.capabilities[0]!, { output: {} });
    expect(compileExtension(JSON.stringify(empty), 'manifest').operations[0]?.eligible).toBe(false);
  });
  it('rejects remote/file refs, cyclic refs, incompatible versions, scripts and credential literals', () => {
    for (const ref of ['https://fixture.invalid/schema.json', 'file:///etc/passwd', '#/components/schemas/Result']) {
      const source = document(); Object.assign(source.components.schemas.Result, { $ref: ref });
      expect(() => compileExtension(JSON.stringify(source), 'openapi', 'fixture_extension')).toThrow(/引用/);
    }
    expect(() => compileExtension(JSON.stringify({ ...document(), openapi: '3.1.0' }), 'openapi', 'fixture_extension')).toThrow(/3.0/);
    expect(() => parseExtensionSource('test: !!js/function function() {}')).toThrow(/标签/);
    expect(() => parseExtensionSource('x-code: console.log(1)')).toThrow(/脚本/);
    const source = manifest(); Object.assign(source.http, { headers: { Authorization: 'Bearer pasted-credential' } });
    expect(() => compileExtension(JSON.stringify(source), 'manifest')).toThrow(/实际凭据/);
    const withValue = { ...manifest(), auth: { type: 'bearer', fields: { token: { type: 'string', default: 'pasted-credential' } } } };
    expect(() => compileExtension(JSON.stringify(withValue), 'manifest')).toThrow(/凭据值/);
  });
  it('rejects prototype keys, duplicate YAML keys, large input, excessive operations, aliases and deep structures', () => {
    expect(() => parseExtensionSource('{"__proto__":{"polluted":true}}')).toThrow(/对象键/);
    expect(() => parseExtensionSource('a: 1\na: 2')).toThrow(/重复/);
    expect(() => parseExtensionSource(' '.repeat(128 * 1024 + 1))).toThrow(/128/);
    const source = manifest(); source.capabilities = Array.from({ length: 51 }, (_, index) => ({ ...source.capabilities[0]!, id: `read.${index}` }));
    expect(() => compileExtension(JSON.stringify(source), 'manifest')).toThrow(/50/);
    expect(() => parseExtensionSource('a: &a [1, 2]\nb: &b [*a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b]')).toThrow(/别名/);
    let nested: unknown = 'leaf'; for (let index = 0; index < 26; index++) nested = { nested };
    expect(() => parseExtensionSource(JSON.stringify(nested))).toThrow(/24/);
  });
  it('rejects ambiguous auth and unsupported response constraints instead of silently changing their meaning', () => {
    const auth = document(); Object.assign(auth.paths['/accounts/{id}'].get, { security: [] });
    expect(() => compileExtension(JSON.stringify(auth), 'openapi', 'fixture_extension')).toThrow(/认证不同/);
    const constraint = document(); Object.assign(constraint.components.schemas.Result, { oneOf: [{ type: 'string' }] });
    expect(() => compileExtension(JSON.stringify(constraint), 'openapi', 'fixture_extension')).toThrow(/组合/);
  });
});
