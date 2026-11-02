import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, loadManifestFile } from '../src/loader.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MANIFEST_PATH = resolve(__dirname, '../../../connectors/test-connector/manifest.yaml');

const BASE = `
connector: bilibili
version: 0.1.0
title: Bilibili
access: browser
capabilities:
  - id: account.profile
    kind: query
    effect: read
    cache: null
    title: 个人资料
    request: { method: GET, path: /x/web-interface/nav }
`;

function manifest(extra: string): string {
  return BASE + extra;
}

const LOGIN_OK = `
login:
  url: https://passport.bilibili.com/login
  success_when:
    any:
      - cookie: { name: SESSDATA, domain: .bilibili.com }
  whoami: account.profile
  allowed_domains: [bilibili.com, hdslb.com, bilivideo.com, biliapi.net]
`;

describe('loadManifest — login block', () => {
  it('parses the §4.4.3 example', () => {
    const c = loadManifest(manifest(LOGIN_OK));
    expect(c.login).toBeDefined();
    expect(c.login?.url).toBe('https://passport.bilibili.com/login');
    expect(c.login?.successWhen).toEqual({ type: 'cookie', name: 'SESSDATA', domain: '.bilibili.com' });
    expect(c.login?.whoami).toBe('account.profile');
    expect(c.login?.allowedDomains).toEqual(['bilibili.com', 'hdslb.com', 'bilivideo.com', 'biliapi.net']);
    expect(c.login).not.toHaveProperty('qrSelector');
  });

  it('parses url_not_contains and omits absent optional fields', () => {
    const c = loadManifest(manifest(`
login:
  url: https://example.com/login
  success_when:
    any:
      - url_not_contains: /login
`));
    expect(c.login).toEqual({
      url: 'https://example.com/login',
      successWhen: { type: 'url_not_contains', pattern: '/login' },
    });
  });

  it('uses the first condition when several are listed', () => {
    const c = loadManifest(manifest(`
login:
  url: https://example.com/login
  success_when:
    any:
      - url_not_contains: /login
      - cookie: { name: sid, domain: example.com }
`));
    expect(c.login?.successWhen).toEqual({ type: 'url_not_contains', pattern: '/login' });
  });

  it('reads qr_selector from top level, and prefers the one inside login', () => {
    const top = loadManifest(manifest(`qr_selector: '#qr-top'\n${LOGIN_OK}`));
    expect(top.login?.qrSelector).toBe('#qr-top');

    const both = loadManifest(manifest(`qr_selector: '#qr-top'\n${LOGIN_OK}  qr_selector: '#qr-login'\n`));
    expect(both.login?.qrSelector).toBe('#qr-login');
  });

  it('login is undefined when the block is absent', () => {
    const c = loadManifest(BASE);
    expect(c.login).toBeUndefined();
    expect(c).not.toHaveProperty('login');
    expect(loadManifestFile(MANIFEST_PATH).login).toBeUndefined();
  });

  it('rejects a missing url', () => {
    expect(() => loadManifest(manifest(`
login:
  success_when:
    any:
      - url_not_contains: /login
`))).toThrow(/manifest\.login\.url/);
  });

  it('rejects a non-http url', () => {
    expect(() => loadManifest(manifest(`
login:
  url: javascript:alert(1)
  success_when: { any: [ { url_not_contains: /login } ] }
`))).toThrow(/manifest\.login\.url must use http or https/);
  });

  it('rejects an empty success_when.any', () => {
    expect(() => loadManifest(manifest(`
login:
  url: https://example.com/login
  success_when:
    any: []
`))).toThrow(/manifest\.login\.success_when\.any must be a non-empty array/);
  });

  it('rejects a missing success_when', () => {
    expect(() => loadManifest(manifest(`
login:
  url: https://example.com/login
`))).toThrow(/manifest\.login\.success_when/);
  });

  it('rejects an unknown condition type', () => {
    expect(() => loadManifest(manifest(`
login:
  url: https://example.com/login
  success_when:
    any:
      - header: { name: X-Auth }
`))).toThrow(/manifest\.login\.success_when\.any\[0\]: unknown condition type "header"/);
  });

  it('reports the full path for a bad cookie field', () => {
    expect(() => loadManifest(manifest(`
login:
  url: https://example.com/login
  success_when:
    any:
      - cookie: { domain: example.com }
`))).toThrow(/manifest\.login\.success_when\.any\[0\]\.cookie\.name/);
  });

  it('rejects bad qr_selector, whoami and allowed_domains types', () => {
    expect(() => loadManifest(manifest(`${LOGIN_OK}  qr_selector: 42\n`))).toThrow(
      /manifest\.login\.qr_selector/,
    );
    expect(() => loadManifest(manifest(`
login:
  url: https://example.com/login
  success_when: { any: [ { url_not_contains: /login } ] }
  whoami: 7
`))).toThrow(/manifest\.login\.whoami/);
    expect(() => loadManifest(manifest(`
login:
  url: https://example.com/login
  success_when: { any: [ { url_not_contains: /login } ] }
  allowed_domains: example.com
`))).toThrow(/manifest\.login\.allowed_domains/);
  });
});
