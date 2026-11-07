import { describe, expect, it } from 'vitest';
import { defaultInput, loadManifest, projectOutput } from '../src/index.js';

describe('declared output projection and role metadata', () => {
  it('retains only declared nested properties and never forwards channel keys or dynamic extras', () => {
    const schema = { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, details: { type: 'object', properties: { value: { type: 'number' } } } } } };
    expect(projectOutput([{ id: 1, key: 'secret', details: { value: 2, access_token: 'also-secret' }, unknown: {} }], schema)).toEqual([{ id: 1, details: { value: 2 } }]);
    expect(projectOutput({ something: 'unknown' }, {})).toEqual({});
    expect(projectOutput(['a', 'b'], { type: 'array', items: { type: 'string' } })).toEqual(['a', 'b']);
  });
  it('keeps schema defaults separate from caller input and preserves zero, false and explicit values', () => {
    const input = { page: 0, flag: false };
    expect(defaultInput(input, { properties: { page: { default: 1 }, page_size: { default: 20 }, model_name: { default: '' }, flag: { default: true } } })).toEqual({ page: 0, page_size: 20, model_name: '', flag: false });
    expect(input).toEqual({ page: 0, flag: false });
  });
  const manifest = (roles: string) => `connector: fixture\nversion: '1'\ntitle: Fixture\naccess: official_api\ncapabilities:\n  - id: channel.list\n    title: Channels\n    kind: query\n    effect: read\n    roles: ${roles}\n    request: {method: GET, path: /channels}\n`;
  it('preserves roles both in the canonical capability and runtime definition', () => {
    const result = loadManifest(manifest('[admin]'));
    expect(result.capabilities['channel.list']?.roles).toEqual(['admin']);
    expect(result.capabilityDefs?.['channel.list']?.roles).toEqual(['admin']);
  });
  it.each(['[]', '[root]', 'admin'])('rejects unsupported role declarations %s', (roles) => expect(() => loadManifest(manifest(roles))).toThrow('roles'));
});
