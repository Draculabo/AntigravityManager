import { describe, expect, it } from 'vitest';
import { normalizeObjectJsonSchema } from '@/modules/proxy-gateway/antigravity/JsonSchemaUtils';
import {
  DEFAULT_SCHEMA_LIMITS,
  SchemaConversionBatch,
  SchemaInputError,
} from '@/modules/proxy-gateway/antigravity/schema/SchemaConversion';
import { STRING_SCHEMA_FALLBACK } from '@/modules/proxy-gateway/antigravity/schema/JsonSchemaReferenceResolver';

describe('bounded schema reference preparation', () => {
  it('resolves complete escaped and percent-encoded pointers without definition collisions', () => {
    const schema = {
      type: 'object',
      $defs: {
        same: { type: 'string' },
        'a/b~c': { type: 'integer' },
        nested: { definitions: { same: { type: 'boolean' } } },
      },
      definitions: { same: { type: 'number' } },
      properties: {
        a: { $ref: '#/$defs/same' },
        b: { $ref: '#/definitions/same' },
        c: { $ref: '#/$defs/a~1b%7E0c' },
        d: { $ref: '#/$defs/nested/definitions/same' },
        repeated: { $ref: '#/$defs/same' },
      },
    };
    const original = structuredClone(schema);
    expect(normalizeObjectJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'number' },
        c: { type: 'integer' },
        d: { type: 'boolean' },
        repeated: { type: 'string' },
      },
    });
    expect(schema).toEqual(original);
  });

  it('resolves array indexes and keeps reference siblings authoritative', () => {
    expect(
      normalizeObjectJsonSchema({
        type: 'object',
        $defs: { list: [{ type: 'integer', description: 'target' }] },
        properties: { a: { $ref: '#/$defs/list/0', type: 'string', description: 'sibling' } },
      }),
    ).toEqual({ type: 'object', properties: { a: { type: 'string', description: 'sibling' } } });
  });

  it.each([
    'https://example.invalid/same',
    '#missing',
    '#/$defs/missing',
    '#/$defs/invalid~2',
    '#/$defs/list/01',
    '#/%ZZ',
  ])('degrades invalid child reference %s without losing required or siblings', (reference) => {
    const batch = new SchemaConversionBatch();
    expect(
      normalizeObjectJsonSchema(
        {
          type: 'object',
          $defs: { same: { type: 'number' }, list: [{ type: 'string' }] },
          properties: {
            broken: {
              $ref: reference,
              type: 'object',
              properties: { discarded: { type: 'number' } },
            },
            valid: { type: 'boolean' },
          },
          required: ['broken', 'valid'],
        },
        batch,
        'tool',
        2,
      ),
    ).toEqual({
      type: 'object',
      properties: { broken: STRING_SCHEMA_FALLBACK, valid: { type: 'boolean' } },
      required: ['broken', 'valid'],
    });
    expect(batch.issues).toHaveLength(1);
    expect(batch.issues[0]).toMatchObject({ recovered: true, toolOrdinal: 2 });
  });

  it('detects reachable cycles while ignoring unused recursive definitions', () => {
    const batch = new SchemaConversionBatch();
    const result = normalizeObjectJsonSchema(
      {
        type: 'object',
        $defs: {
          loop: { type: 'object', properties: { next: { $ref: '#/$defs/loop' } } },
          unused: { $ref: '#/$defs/unused' },
        },
        properties: { value: { $ref: '#/$defs/loop' } },
      },
      batch,
    );
    expect(result).toEqual({
      type: 'object',
      properties: { value: { type: 'object', properties: { next: STRING_SCHEMA_FALLBACK } } },
    });
    expect(batch.issues).toEqual([{ kind: 'reference-cycle', recovered: true, toolOrdinal: null }]);
  });

  it('keeps reference-looking const data literal', () => {
    expect(
      normalizeObjectJsonSchema({
        type: 'object',
        properties: { literal: { const: { $ref: '#/missing', type: 'NUMBER' } } },
      }),
    ).toEqual({
      type: 'object',
      properties: { literal: { type: 'object', enum: ['{"$ref":"#/missing","type":"NUMBER"}'] } },
    });
  });

  it.each([{ $ref: '#/missing' }, { type: 'array' }, null, false, { $ref: '#' }])(
    'rejects an unrepresentable tool root',
    (schema) => {
      expect(() => normalizeObjectJsonSchema(schema)).toThrow(SchemaInputError);
    },
  );

  it('rejects structured-output child failures and retains valid array output schemas', () => {
    expect(() =>
      normalizeObjectJsonSchema(
        { type: 'object', properties: { value: { $ref: '#missing' } } },
        undefined,
        'output',
      ),
    ).toThrow('unsupported-reference');
    expect(
      normalizeObjectJsonSchema({ type: 'array', items: { type: 'string' } }, undefined, 'output'),
    ).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('degrades unsupported resource scope changes and dynamic references', () => {
    const batch = new SchemaConversionBatch();
    expect(
      normalizeObjectJsonSchema(
        {
          type: 'object',
          properties: {
            dynamic: { $dynamicRef: '#target' },
            scoped: { $id: 'child', type: 'string' },
          },
        },
        batch,
      ),
    ).toEqual({
      type: 'object',
      properties: { dynamic: STRING_SCHEMA_FALLBACK, scoped: STRING_SCHEMA_FALLBACK },
    });
    expect(batch.issueCount).toBe(2);
  });

  it('rejects deep/cyclic input before cloning and bounds cumulative requests', () => {
    const cyclic: { type: string; self?: unknown } = { type: 'object' };
    cyclic.self = cyclic;
    expect(() => normalizeObjectJsonSchema(cyclic)).toThrow('invalid-input');
    const batch = new SchemaConversionBatch({ ...DEFAULT_SCHEMA_LIMITS, requestNodes: 15 });
    normalizeObjectJsonSchema(undefined, batch);
    expect(() => normalizeObjectJsonSchema(undefined, batch)).toThrow('request-budget');
    expect(() =>
      normalizeObjectJsonSchema(
        { type: 'object', description: 'x'.repeat(200) },
        new SchemaConversionBatch({ ...DEFAULT_SCHEMA_LIMITS, schemaBytes: 100 }),
      ),
    ).toThrow('input-budget');
  });

  it('bounds diagnostics and defaults only omitted tool schemas', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [String(index), { $ref: '#missing' }]),
    );
    const batch = new SchemaConversionBatch();
    normalizeObjectJsonSchema({ type: 'object', properties }, batch);
    expect(batch.issueCount).toBe(40);
    expect(batch.issues).toHaveLength(32);
    expect(normalizeObjectJsonSchema(undefined)).toEqual({ type: 'object', properties: {} });
    expect(() => normalizeObjectJsonSchema(undefined, undefined, 'output')).toThrow(
      'invalid-input',
    );
  });

  it('bounds a reference chain whose document is shallow but expansion is deep', () => {
    const definitions = Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [
        String(index),
        index === 69 ? { type: 'string' } : { $ref: `#/$defs/${index + 1}` },
      ]),
    );
    const batch = new SchemaConversionBatch();
    expect(
      normalizeObjectJsonSchema(
        {
          type: 'object',
          $defs: definitions,
          properties: { chain: { $ref: '#/$defs/0' }, valid: { type: 'integer' } },
          required: ['chain'],
        },
        batch,
      ),
    ).toEqual({
      type: 'object',
      properties: { chain: STRING_SCHEMA_FALLBACK, valid: { type: 'integer' } },
      required: ['chain'],
    });
    expect(batch.issues).toEqual([
      { kind: 'expansion-budget', recovered: true, toolOrdinal: null },
    ]);
  });
});
