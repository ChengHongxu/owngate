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

  it('finds missing annotations inside real Zod arrays and nested arrays even when their containers are annotated', () => {
    const schema = z.object({
      accounts: field(z.array(z.object({
        email: z.string(),
        balance: field(z.number(), { sensitivity: 'financial' }),
        events: field(z.array(z.object({ body: z.string() })), { sensitivity: 'content' }),
      })), { sensitivity: 'content' }),
    });
    expect(findUnannotatedFields(toJSONSchema(schema))).toEqual(['accounts[].email', 'accounts[].events[].body']);
  });

  it('walks Zod unions and intersections while leaving the existing per-property annotation requirement intact', () => {
    const schema = z.object({
      result: field(z.union([
        z.object({ email: z.string() }),
        z.object({ balance: field(z.number(), { sensitivity: 'financial' }) }),
      ]), { sensitivity: 'content' }),
      profile: field(z.intersection(
        z.object({ display_name: z.string() }),
        z.object({ bio: field(z.string(), { untrusted: true }) }),
      ), { sensitivity: 'content' }),
    });
    expect(findUnannotatedFields(toJSONSchema(schema))).toEqual(['result.email', 'profile.display_name']);
  });

  it('handles nullable and implicit object types plus all composition branches, without duplicate paths', () => {
    expect(findUnannotatedFields({
      properties: {
        profile: { type: ['object', 'null'], 'x-sensitivity': 'content', properties: { name: { type: 'string' } } },
        result: { 'x-sensitivity': 'content', oneOf: [
          { properties: { raw: { type: 'string' } } },
          { allOf: [{ properties: { raw: { type: 'number' }, safe: { 'x-untrusted': true } } }] },
        ] },
      },
    })).toEqual(['profile.name', 'result.raw']);
  });

  it('walks tuple elements and explicitly typed dynamic object values', () => {
    const schema = {
      properties: {
        tuple: { 'x-sensitivity': 'content', items: [{ properties: { raw: { type: 'string' } } }, { type: 'number' }] },
        modern: { 'x-sensitivity': 'content', prefixItems: [{ properties: { raw: { type: 'string' } } }] },
        lookup: { 'x-sensitivity': 'content', additionalProperties: { properties: { email: { type: 'string' } } } },
      },
    };
    expect(findUnannotatedFields(schema)).toEqual(['tuple[0].raw', 'modern[0].raw', 'lookup.*.email']);
  });

  it('preserves caller path prefixes, scans shared schemas at each path, and terminates in-memory cycles', () => {
    const shared: Record<string, unknown> = { properties: { raw: { type: 'string' } } };
    const root = { properties: { first: { 'x-sensitivity': 'content', items: shared }, second: { 'x-sensitivity': 'content', items: shared } } };
    expect(findUnannotatedFields(root, 'payload')).toEqual(['payload.first[].raw', 'payload.second[].raw']);
    shared['anyOf'] = [shared];
    expect(findUnannotatedFields(root)).toEqual(['first[].raw', 'second[].raw']);
  });
});
