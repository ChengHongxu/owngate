import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, loadManifestFile } from '../src/loader.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MANIFEST_PATH = resolve(__dirname, './fixtures/connectors/test-connector/manifest.yaml');

describe('capability schema fidelity', () => {
  it('preserves input types and nullable numeric outputs rather than declaring every value a string', () => {
    const compiled = loadManifest(`
connector: typed
version: 1.0.0
title: Typed
access: official_api
capabilities:
  - id: usage.get
    kind: query
    effect: read
    title: Usage
    request: { method: GET, path: /usage }
    input:
      type: object
      required: [limit]
      additionalProperties: false
      properties: { limit: { type: integer, minimum: 1, maximum: 100 } }
    output:
      amount: { from: $.amount, type: number, sensitivity: financial }
      count: { from: $.count, transform: number_or_null, sensitivity: content }
`);
    expect(compiled.capabilities['usage.get']?.input).toMatchObject({ required: ['limit'], properties: { limit: { type: 'integer', maximum: 100 } } });
    const output = compiled.capabilities['usage.get']?.output['properties'] as Record<string, Record<string, unknown>>;
    expect(output['amount']?.['type']).toEqual(['number', 'null']);
    expect(output['count']?.['type']).toEqual(['number', 'null']);
    expect(output['amount']?.['x-sensitivity']).toBe('financial');
  });
});

describe('loadManifestFile — test-connector', () => {
  it('loads the manifest without throwing', () => {
    expect(() => loadManifestFile(MANIFEST_PATH)).not.toThrow();
  });

  it('has correct id, version, and transport', () => {
    const c = loadManifestFile(MANIFEST_PATH);
    expect(c.id).toBe('test-connector');
    expect(c.version).toBe('1.0.0');
    expect(c.transport).toBe('http');
  });

  it('exposes echo.ping and echo.status capabilities', () => {
    const { capabilities } = loadManifestFile(MANIFEST_PATH);
    expect(Object.keys(capabilities)).toContain('echo.ping');
    expect(Object.keys(capabilities)).toContain('echo.status');
  });

  it('echo.ping has cache.ttl === 30', () => {
    const { capabilities } = loadManifestFile(MANIFEST_PATH);
    const ping = capabilities['echo.ping'];
    expect(ping).toBeDefined();
    expect(ping?.cache).toEqual({ ttl: 30 });
  });

  it('echo.status has cache === null', () => {
    const { capabilities } = loadManifestFile(MANIFEST_PATH);
    const status = capabilities['echo.status'];
    expect(status).toBeDefined();
    expect(status?.cache).toBeNull();
  });

  it('echo.ping output field "message" has x-sensitivity: content', () => {
    const { capabilities } = loadManifestFile(MANIFEST_PATH);
    const ping = capabilities['echo.ping'];
    expect(ping?.output).toBeDefined();
    const props = (ping?.output as Record<string, unknown>)?.['properties'] as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(props?.['message']?.['x-sensitivity']).toBe('content');
  });

  it('echo.status output field "ok" has x-sensitivity: content', () => {
    const { capabilities } = loadManifestFile(MANIFEST_PATH);
    const status = capabilities['echo.status'];
    const props = (status?.output as Record<string, unknown>)?.['properties'] as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(props?.['ok']?.['x-sensitivity']).toBe('content');
  });

  it('echo.ping kind is query and effect is read', () => {
    const { capabilities } = loadManifestFile(MANIFEST_PATH);
    const ping = capabilities['echo.ping'];
    expect(ping?.kind).toBe('query');
    expect(ping?.effect).toBe('read');
  });

  it('query capability approval defaults to never', () => {
    const { capabilities } = loadManifestFile(MANIFEST_PATH);
    expect(capabilities['echo.ping']?.approval).toBe('never');
  });
});

describe('declared capability support', () => {
  it('keeps implemented browser reads unverified while site writes remain disabled', () => {
    const compiled = loadManifestFile(resolve(__dirname, '../../../connectors/bilibili/manifest.yaml'));
    const capabilities = Object.values(compiled.capabilities);
    expect(capabilities.some(capability => capability.kind === 'query')).toBe(true);
    for (const capability of capabilities) {
      expect(capability.support.status, capability.id).toBe(capability.kind === 'action' ? 'disabled' : 'unverified');
    }
  });

  it('keeps declared HTTP reads implemented without claiming a connection has been verified', () => {
    const compiled = loadManifestFile(MANIFEST_PATH);
    expect(compiled.capabilities['echo.ping']?.support.status).toBe('supported');
  });
});

describe('loadManifest — invalid manifests', () => {
  it('throws when required "connector" field is missing', () => {
    const yaml = `
version: 1.0.0
title: Broken
access: official_api
capabilities:
  - id: foo.bar
    kind: query
    effect: read
    cache: null
    title: Foo
    description: bar
    request: { method: GET, path: /get }
`;
    expect(() => loadManifest(yaml)).toThrow();
  });

  it('throws when "version" is missing', () => {
    const yaml = `
connector: x
title: X
access: official_api
capabilities:
  - id: foo.bar
    kind: query
    effect: read
    cache: null
    title: Foo
    description: bar
    request: { method: GET, path: /get }
`;
    expect(() => loadManifest(yaml)).toThrow();
  });

  it('throws when "access" has an invalid value', () => {
    const yaml = `
connector: x
version: 1.0.0
title: X
access: unknown_mode
capabilities:
  - id: foo.bar
    kind: query
    effect: read
    cache: null
    title: Foo
    description: bar
    request: { method: GET, path: /get }
`;
    expect(() => loadManifest(yaml)).toThrow(/access/);
  });

  it('throws when capabilities array is empty', () => {
    const yaml = `
connector: x
version: 1.0.0
title: X
access: official_api
capabilities: []
`;
    expect(() => loadManifest(yaml)).toThrow(/capabilities/);
  });

  it('throws when an output field has an unknown transform', () => {
    const yaml = `
connector: x
version: 1.0.0
title: X
access: official_api
capabilities:
  - id: foo.bar
    kind: query
    effect: read
    cache: null
    title: Foo
    description: bar
    request: { method: GET, path: /get }
    output:
      val:
        from: "$.val"
        transform: nonexistent_transform
`;
    expect(() => loadManifest(yaml)).toThrow(/unknown transform/i);
  });

  it('throws on duplicate capability ids', () => {
    const yaml = `
connector: x
version: 1.0.0
title: X
access: official_api
capabilities:
  - id: foo.bar
    kind: query
    effect: read
    cache: null
    title: Foo
    description: bar
    request: { method: GET, path: /get }
  - id: foo.bar
    kind: query
    effect: read
    cache: null
    title: Foo2
    description: bar2
    request: { method: GET, path: /get2 }
`;
    expect(() => loadManifest(yaml)).toThrow(/duplicate/i);
  });
});

describe('trusted ADAPTER read paths', () => {
  function source(paths: unknown, method = 'ADAPTER', effect = 'read') {
    return JSON.stringify({
      connector: 'trusted-adapter', version: '1.0.0', title: 'Trusted adapter', access: 'official_api',
      capabilities: [{ id: 'balance.get', title: 'Balance', kind: 'query', effect,
        input: { type: 'object', properties: { account_id: { type: 'string' }, page: { type: ['integer', 'null'] }, filter: { type: 'object' } } },
        request: { method, path: '/adapter', readonly_paths: paths },
      }],
    });
  }
  it('preserves a bounded list of exact scalar input templates for the broker to render', () => {
    const paths = ['/v1/account/{{input.account_id}}', '/v1/usage?page={{ input.page }}', '/v1/status'];
    const compiled = loadManifest(source(paths));
    expect(compiled.capabilityDefs?.['balance.get']?.request).toEqual({ method: 'ADAPTER', path: '/adapter', readonly_paths: paths });
    expect(loadManifest(source([])).capabilityDefs?.['balance.get']?.request.readonly_paths).toEqual([]);
  });
  it('rejects read-path declarations for ordinary HTTP methods and non-read effects', () => {
    expect(() => loadManifest(source(['/v1/status'], 'GET'))).toThrow(/read-only ADAPTER/);
    expect(() => loadManifest(source(['/v1/status'], 'ADAPTER', 'write'))).toThrow(/read-only ADAPTER/);
  });
  it('rejects excessive, duplicate, malformed or cross-origin paths', () => {
    for (const value of [
      Array.from({ length: 11 }, (_, index) => `/v1/${index}`), ['/same', '/same'], ['https://elsewhere.invalid/api'], ['//elsewhere.invalid/api'], ['/\\elsewhere.invalid'], ['/status#fragment'], ['/status\r\nAuthorization: secret'], [42], '/status',
    ]) expect(() => loadManifest(source(value))).toThrow(/readonly_paths/);
  });
  it('accepts only declared scalar input substitutions, without config/secret/function/wildcard expansion', () => {
    for (const path of ['/api/{{secret.token}}', '/api/{{config.host}}', '/api/{{input.unknown}}', '/api/{{input.filter}}', '/api/{{input.account_id.toString()}}', '/api/{id}']) {
      expect(() => loadManifest(source([path])), path).toThrow(/readonly_paths/);
    }
    // An asterisk is a literal URL character, never a wildcard matcher.
    expect(loadManifest(source(['/api/*'])).capabilityDefs?.['balance.get']?.request.readonly_paths).toEqual(['/api/*']);
  });
});
