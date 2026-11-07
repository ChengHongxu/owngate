import { describe, it, expect } from 'vitest';
import { Vault } from '../src/vault.js';
import { redact, SecretRedactor } from '../src/redact.js';
import type { JSONSchema } from '@owngate/core';

const CONTEXT = ['test', 'record', 'value'] as const;
const TEST_KEY = 'a'.repeat(64); // 32 bytes hex

describe('Vault encrypt/decrypt', () => {
  it('round-trips a string', () => {
    const v = new Vault(TEST_KEY);
    const enc = v.encrypt('hello world', CONTEXT);
    expect(enc.ciphertext).not.toBe('hello world');
    expect(v.decrypt(enc, CONTEXT)).toBe('hello world');
  });

  it('round-trips JSON', () => {
    const v = new Vault(TEST_KEY);
    const enc = v.encryptJSON({ token: 'abc123', scopes: ['read', 'write'] }, CONTEXT);
    const out = v.decryptJSON(enc, CONTEXT);
    expect(out).toEqual({ token: 'abc123', scopes: ['read', 'write'] });
  });

  it('produces unique IVs for each encryption', () => {
    const v = new Vault(TEST_KEY);
    const a = v.encrypt('same', CONTEXT);
    const b = v.encrypt('same', CONTEXT);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('fails on tampered ciphertext', () => {
    const v = new Vault(TEST_KEY);
    const enc = v.encrypt('secret', CONTEXT);
    const tampered = { ...enc, ciphertext: 'AAAA' + enc.ciphertext.slice(4) };
    expect(() => v.decrypt(tampered, CONTEXT)).toThrow();
  });

  it('rejects wrong key length', () => {
    expect(() => new Vault('short')).toThrow(/Master key must be/);
  });

  it('hashToken is deterministic and one-way', () => {
    const h1 = Vault.hashToken('my-token');
    const h2 = Vault.hashToken('my-token');
    const h3 = Vault.hashToken('other-token');
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toHaveLength(64);
  });
});

describe('redact', () => {
  const schema: JSONSchema = {
    type: 'object',
    properties: {
      balance: { type: 'number', 'x-sensitivity': 'financial', 'x-unit': 'USD' },
      email: { type: 'string', 'x-sensitivity': 'pii' },
      title: { type: 'string', 'x-untrusted': true },
      count: { type: 'number' },
    },
  };

  it('shows personal information only when explicitly allowed', () => {
    const data = { balance: 42, email: 'a@b.com', title: 'hi', count: 3 };
    const { data: out, redacted } = redact(data, schema, { includePii: true });
    expect(redacted).toEqual([]);
    expect((out as Record<string, unknown>)['balance']).toBe(42);
    expect((out as Record<string, unknown>)['email']).toBe('a@b.com');
    expect((out as Record<string, unknown>)['title']).toBe('hi');
    expect((out as Record<string, unknown>)['count']).toBe(3);
  });

  it('keeps administrator business fields with explicit personal information access', () => {
    const data = { balance: 42, email: 'a@b.com', title: 'hi', count: 3 };
    const { data: out, redacted } = redact(data, schema, { includePii: true });
    expect(redacted).toEqual([]);
    expect((out as Record<string, unknown>)['balance']).toBe(42);
    expect((out as Record<string, unknown>)['email']).toBe('a@b.com');
  });

  it('respects includePii flag', () => {
    const data = { balance: 42, email: 'a@b.com', title: 'hi', count: 3 };
    const { data: out, redacted } = redact(data, schema, { includePii: true });
    expect(redacted).not.toContain('email');
    expect((out as Record<string, unknown>)['email']).toBe('a@b.com');
    expect((out as Record<string, unknown>)['balance']).toBe(42);
  });

  it('handles nested objects', () => {
    const nestedSchema: JSONSchema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            name: { type: 'string', 'x-sensitivity': 'pii' },
            id: { type: 'number' },
          },
        },
      },
    };
    const data = { user: { name: 'Alice', id: 1 } };
    const { data: out, redacted } = redact(data, nestedSchema, {});
    expect(redacted).toContain('user.name');
    expect((out as { user: Record<string, unknown> }).user['name']).toBeNull();
    expect((out as { user: Record<string, unknown> }).user['id']).toBe(1);
  });

  it('hides PII by default while retaining financial and content fields', () => {
    const { data: out, redacted } = redact({ balance: 42, email: 'a@b.com', title: 'hi', count: 3 }, schema);
    expect(out).toEqual({ balance: 42, email: null, title: 'hi', count: 3 });
    expect(redacted).toEqual(['email']);
  });

  it('supports a stricter visibility policy for any caller', () => {
    const { data: out } = redact({ balance: 42, email: 'a@b.com', title: 'hi', count: 3 }, schema, {
      includePii: false, includeFinancial: false, includeUntrusted: false,
    });
    expect(out).toEqual({ balance: null, email: null, title: null, count: 3 });
  });

  it('removes undeclared fields and masks declared secret fields even for admins', () => {
    const { data: out, redacted } = redact({ balance: 42, unexpected: 'secret', access_token: 'secret-token' }, {
      type: 'object', properties: { balance: { type: 'number' }, access_token: { type: 'string', 'x-secret': true } },
    }, { includePii: true });
    expect(out).toEqual({ balance: 42, access_token: null });
    expect(redacted).toEqual(['unexpected', 'access_token']);
  });

  it('filters nested array entries according to the item schema', () => {
    const { data: out, redacted } = redact([{ name: 'Alice', balance: 2, extra: 'secret' }], {
      type: 'array', items: { type: 'object', properties: { name: { type: 'string', 'x-sensitivity': 'pii' }, balance: { type: 'number' } } },
    });
    expect(out).toEqual([{ name: null, balance: 2 }]);
    expect(redacted).toContain('[0].name');
    expect(redacted).toContain('[0].extra');
  });
});

describe('SecretRedactor', () => {
  it('scrubs registered values from nested results and errors without mutating raw data', () => {
    const redactor = new SecretRedactor();
    redactor.register('conn-1', ['fixture-sensitive-value']);
    const raw = { message: 'upstream echoed fixture-sensitive-value', nested: ['fixture-sensitive-value'] };
    expect(redactor.redact(raw)).toEqual({ message: 'upstream echoed [REDACTED]', nested: ['[REDACTED]'] });
    expect(raw.message).toContain('fixture-sensitive-value');
  });

  it('updates and unregisters secrets by connection', () => {
    const redactor = new SecretRedactor();
    redactor.register('conn-1', ['old-secret']);
    redactor.register('conn-1', ['new-secret']);
    expect(redactor.redact('old-secret new-secret')).toBe('old-secret [REDACTED]');
    redactor.unregister('conn-1');
    expect(redactor.redact('new-secret')).toBe('new-secret');
  });

  it('masks common token patterns and credential field names', () => {
    const redactor = new SecretRedactor();
    const out = redactor.redact({
      token: 'short-fixture',
      message: 'Authorization: Bearer fixture-token\nCookie: session=fixture-cookie',
      another: 'sk-fixture12345678',
      admin: `admin-${'a'.repeat(64)}`,
    });
    expect(out.token).toBe('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain('fixture-token');
    expect(JSON.stringify(out)).not.toContain('fixture-cookie');
    expect(JSON.stringify(out)).not.toContain('sk-fixture');
    expect(out.admin).toBe('[REDACTED]');
  });
});

describe('per-record envelope encryption and AAD', () => {
  it('rejects a ciphertext moved to a different credential field, connection or namespace', () => {
    const vault = new Vault(TEST_KEY);
    const context = ['credential', 'connection-a', 'access_token'] as const;
    const blob = vault.encrypt('private credential', context);
    expect(blob.ciphertext.startsWith('og2:')).toBe(true);
    for (const moved of [
      ['credential', 'connection-b', 'access_token'],
      ['credential', 'connection-a', 'refresh_token'],
      ['task', 'connection-a', 'access_token'],
    ] as const) expect(() => vault.decrypt(blob, moved)).toThrow('wrong key, context, or corrupted');
    expect(vault.decrypt(blob, context)).toBe('private credential');
  });

  it('rejects v2 reads without an explicit record context and rejects invalid key encodings', () => {
    const vault = new Vault(TEST_KEY);
    const blob = vault.encrypt('secret', CONTEXT);
    expect(() => vault.decrypt(blob, undefined as unknown as typeof CONTEXT)).toThrow();
    expect(() => new Vault(`${TEST_KEY}invalid`)).toThrow('64 hexadecimal');
    expect(() => new Vault('z'.repeat(64))).toThrow('64 hexadecimal');
  });

  it('authenticates the wrapped key and payload independently', () => {
    const vault = new Vault(TEST_KEY);
    const blob = vault.encrypt('secret', CONTEXT);
    const envelope = JSON.parse(Buffer.from(blob.ciphertext.slice(4), 'base64url').toString('utf8'));
    const corrupted = { ...envelope, wrapped_key: { ...envelope.wrapped_key, auth_tag: Buffer.alloc(16).toString('base64') } };
    const tampered = { ...blob, ciphertext: 'og2:' + Buffer.from(JSON.stringify(corrupted)).toString('base64url') };
    expect(() => vault.decrypt(tampered, CONTEXT)).toThrow();
    expect(() => vault.decrypt({ ...blob, iv: Buffer.alloc(12).toString('base64') }, CONTEXT)).toThrow();
    expect(() => new Vault('b'.repeat(64)).decrypt(blob, CONTEXT)).toThrow();
  });

  it('supports empty text and Unicode without changing the bound context', () => {
    const vault = new Vault(TEST_KEY);
    for (const text of ['', '凭据与任务🔐']) expect(vault.decrypt(vault.encrypt(text, CONTEXT), CONTEXT)).toBe(text);
  });
});
