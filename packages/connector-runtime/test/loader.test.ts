import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, loadManifestFile } from '../src/loader.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MANIFEST_PATH = resolve(__dirname, '../../../connectors/test-connector/manifest.yaml');

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
    const props = (ping?.output as Record<string, unknown>)?.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(props?.message?.['x-sensitivity']).toBe('content');
  });

  it('echo.status output field "ok" has x-sensitivity: content', () => {
    const { capabilities } = loadManifestFile(MANIFEST_PATH);
    const status = capabilities['echo.status'];
    const props = (status?.output as Record<string, unknown>)?.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(props?.ok?.['x-sensitivity']).toBe('content');
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
