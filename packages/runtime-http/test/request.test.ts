import { describe, expect, it } from 'vitest';
import { authorizedHttpReads, resolveHttpUrl } from '../src/request.js';
import { job } from './fixtures.js';

describe('capability scoped HTTP reads', () => {
  it('resolves encoded input and scalar defaults identically for worker and broker', () => {
    const fixture = job(); fixture.capability.input = { type: 'object', properties: { id: { type: 'string' }, page: { type: 'integer', default: 2 } } };
    const url = resolveHttpUrl(fixture.connection, fixture.capability, { id: 'a/b ?' }, fixture.definition.http, '/items/{{input.id}}', { page: 'p' });
    expect(url.href).toBe('https://upstream.invalid/items/a%2Fb%20%3F?p=2');
    expect(() => resolveHttpUrl(fixture.connection, fixture.capability, {}, fixture.definition.http, '//other.invalid')).toThrow();
    expect(() => resolveHttpUrl(fixture.connection, fixture.capability, {}, fixture.definition.http, '/balance#fragment')).toThrow();
    expect(() => resolveHttpUrl(fixture.connection, fixture.capability, {}, { base: 'https://user:password@upstream.invalid' }, '/balance')).toThrow();
  });
  it('never treats same origin, prefix paths or asterisks as blanket credential authorization', () => {
    const fixture = job(); fixture.definition.discovery = { quota_ratio: { path: '/status', from: '$.ratio' } };
    let reads = authorizedHttpReads(fixture.connection, fixture.capability, {}, fixture.definition);
    expect([...reads]).toEqual(['GET https://upstream.invalid/balance']);
    expect(reads.has('GET https://upstream.invalid/balance/token')).toBe(false);
    expect(reads.has('HEAD https://upstream.invalid/balance')).toBe(false);
    fixture.definition.output = { balance: { from: '$.quota', transform: 'quota_to_usd' } };
    reads = authorizedHttpReads(fixture.connection, fixture.capability, {}, fixture.definition);
    expect(reads.has('GET https://upstream.invalid/status')).toBe(true);
    fixture.definition.request = { method: 'ADAPTER', path: '/data?page=1', readonly_paths: ['/data?page=2', '/data/*'] };
    reads = authorizedHttpReads(fixture.connection, fixture.capability, {}, fixture.definition);
    expect([...reads]).toEqual(['GET https://upstream.invalid/data?page=1', 'GET https://upstream.invalid/data?page=2', 'GET https://upstream.invalid/data/*']);
    expect(reads.has('GET https://upstream.invalid/data/private')).toBe(false);
    expect(reads.has('GET https://upstream.invalid/status')).toBe(false);
  });
  it('rejects writes even if the caller mislabels the capability or supplies a manifest directly', () => {
    const fixture = job(); fixture.definition.request.method = 'POST';
    expect(() => authorizedHttpReads(fixture.connection, fixture.capability, {}, fixture.definition)).toThrow('writes are disabled');
    fixture.definition.request.method = 'GET'; fixture.capability.effect = 'write';
    expect(() => authorizedHttpReads(fixture.connection, fixture.capability, {}, fixture.definition)).toThrow('writes are disabled');
  });
});
