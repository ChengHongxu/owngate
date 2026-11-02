import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { field, getFieldMeta } from '../src/meta.js';
import { toJSONSchema, findUnannotatedFields } from '../src/export.js';

describe('field() metadata attachment', () => {
  it('attaches metadata to a schema', () => {
    const schema = field(z.number(), { unit: 'USD', scope: 'account' });
    const meta = getFieldMeta(schema);
    expect(meta?.unit).toBe('USD');
    expect(meta?.scope).toBe('account');
  });

  it('does not affect Zod validation behavior', () => {
    const schema = field(z.number().min(0), { unit: 'USD' });
    expect(schema.safeParse(42).success).toBe(true);
    expect(schema.safeParse(-1).success).toBe(false);
  });

  it('marks pii sensitivity', () => {
    const schema = field(z.string(), { sensitivity: 'pii' });
    expect(getFieldMeta(schema)?.sensitivity).toBe('pii');
  });
});

describe('toJSONSchema x-* keywords', () => {
  it('emits x-unit and x-scope', () => {
    const schema = z.object({
      balance: field(z.number(), { unit: 'USD', scope: 'account' }),
    });
    const json = toJSONSchema(schema);
    const props = (json['properties'] as Record<string, Record<string, unknown>>);
    expect(props['balance']?.['x-unit']).toBe('USD');
    expect(props['balance']?.['x-scope']).toBe('account');
  });

  it('emits x-sensitivity for pii fields', () => {
    const schema = z.object({
      email: field(z.string(), { sensitivity: 'pii' }),
    });
    const json = toJSONSchema(schema);
    const props = (json['properties'] as Record<string, Record<string, unknown>>);
    expect(props['email']?.['x-sensitivity']).toBe('pii');
  });

  it('emits x-untrusted for external content', () => {
    const schema = z.object({
      title: field(z.string(), { untrusted: true }),
    });
    const json = toJSONSchema(schema);
    const props = (json['properties'] as Record<string, Record<string, unknown>>);
    expect(props['title']?.['x-untrusted']).toBe(true);
  });

  it('does not emit x-untrusted when false', () => {
    const schema = z.object({
      count: field(z.number(), { unit: 'count' }),
    });
    const json = toJSONSchema(schema);
    const props = (json['properties'] as Record<string, Record<string, unknown>>);
    expect(props['count']?.['x-untrusted']).toBeUndefined();
  });

  it('schema without field() has no x-* keywords', () => {
    const schema = z.object({ raw: z.string() });
    const json = toJSONSchema(schema);
    const props = (json['properties'] as Record<string, Record<string, unknown>>);
    expect(props['raw']?.['x-unit']).toBeUndefined();
  });
});

describe('findUnannotatedFields', () => {
  it('finds fields missing sensitivity and untrusted', () => {
    const schema = z.object({
      balance: field(z.number(), { unit: 'USD', sensitivity: 'financial' }),
      raw_name: z.string(), // missing annotation
    });
    const json = toJSONSchema(schema);
    const unannotated = findUnannotatedFields(json);
    expect(unannotated).toContain('raw_name');
    expect(unannotated).not.toContain('balance');
  });

  it('returns empty array for fully annotated schema', () => {
    const schema = z.object({
      balance: field(z.number(), { sensitivity: 'financial' }),
      title: field(z.string(), { untrusted: true }),
    });
    const json = toJSONSchema(schema);
    expect(findUnannotatedFields(json)).toEqual([]);
  });
});
