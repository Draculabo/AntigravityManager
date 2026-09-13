import { describe, expect, it } from 'vitest';

import {
  cleanJsonSchema,
  type JsonSchemaMap,
  normalizeObjectJsonSchema,
} from '@/modules/proxy-gateway/antigravity/JsonSchemaUtils';

describe('cleanJsonSchema', () => {
  it('drops nested boolean sub-schemas and their required entries', () => {
    const schema: JsonSchemaMap = {
      type: 'object',
      properties: {
        blocked: false,
        nested: {
          type: 'object',
          properties: {
            denied: true,
            allowed: { type: 'string' },
          },
          required: ['denied', 'allowed'],
        },
        list: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              excluded: false,
              included: { type: 'number' },
            },
          },
        },
        invalidItems: {
          type: 'array',
          items: false,
        },
      },
      required: ['blocked', 'nested'],
    };

    cleanJsonSchema(schema);

    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.blocked).toBeUndefined();
    expect(schema.required).toEqual(['nested']);
    expect((properties.nested.properties as Record<string, unknown>).denied).toBeUndefined();
    expect(properties.nested.required).toEqual(['allowed']);
    expect(
      ((properties.list.items as Record<string, unknown>).properties as Record<string, unknown>)
        .excluded,
    ).toBeUndefined();
    expect(properties.invalidItems.items).toBeUndefined();
  });

  it('flattens object definitions without copying malformed definition arrays', () => {
    const schema: JsonSchemaMap = {
      $defs: {
        address: {
          type: 'object',
          properties: {
            street: { type: 'string' },
          },
        },
        malformed: ['not', 'a', 'schema'],
      },
      type: 'object',
      properties: {
        address: { $ref: '#/$defs/address' },
        malformed: { $ref: '#/$defs/malformed' },
      },
    };

    cleanJsonSchema(schema);

    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            street: { type: 'string' },
          },
        },
        malformed: {},
      },
    });
    expect(schema).not.toHaveProperty('$defs');
  });

  it('preserves string enums without rewriting them', () => {
    const enumValues = ['pending', 'running', 'complete'];
    const schema = { type: 'string', enum: enumValues };

    cleanJsonSchema(schema);

    expect(schema.enum).toEqual(enumValues);
  });

  it.each([
    [{ const: 'element' }, { type: 'string', enum: ['element'] }],
    [{ const: 5 }, { type: 'integer', enum: ['5'] }],
    [{ const: 1.5 }, { type: 'number', enum: ['1.5'] }],
    [{ const: true }, { type: 'boolean', enum: ['true'] }],
    [{ const: ['a', 1] }, { type: 'array', enum: ['["a",1]'] }],
    [{ const: { kind: 'element' } }, { type: 'object', enum: ['{"kind":"element"}'] }],
    [{ const: null }, { enum: ['null'] }],
  ])('preserves const semantics as a Gemini-compatible enum', (schema, expected) => {
    cleanJsonSchema(schema);

    expect(schema).toEqual(expected);
  });

  it('does not overwrite an explicit const type and does not duplicate an existing value', () => {
    const schema: JsonSchemaMap = {
      type: 'number',
      const: 5,
      enum: [5, 7],
    };

    cleanJsonSchema(schema);

    expect(schema).toEqual({
      type: 'number',
      enum: ['5', '7'],
    });
  });

  it('does not replace a malformed enum while preserving the inferred const type', () => {
    const schema: JsonSchemaMap = {
      const: 'element',
      enum: 'not-an-array',
    };

    cleanJsonSchema(schema);

    expect(schema).toEqual({
      type: 'string',
    });
  });

  it('stringifies primitive enum members for Gemini string-backed enum types', () => {
    const stringSchema = { type: 'string', enum: [3, 6, 12] };
    const integerSchema = { type: 'integer', enum: [3, 6, 12] };
    const numberSchema = { type: 'number', enum: [0.5, 1.5] };

    cleanJsonSchema(stringSchema);
    cleanJsonSchema(integerSchema);
    cleanJsonSchema(numberSchema);

    expect(stringSchema.enum).toEqual(['3', '6', '12']);
    expect(integerSchema.enum).toEqual(['3', '6', '12']);
    expect(numberSchema.enum).toEqual(['0.5', '1.5']);
  });

  it('removes non-string enums from untyped schemas and preserves their values as hints', () => {
    const untypedSchema: JsonSchemaMap = { enum: [true, false] };

    cleanJsonSchema(untypedSchema);

    expect(untypedSchema.enum).toBeUndefined();
    expect(untypedSchema.description).toContain('enum: true, false');
  });

  it('removes malformed enums and does not coerce union-type enums', () => {
    const malformedSchema: JsonSchemaMap = { type: 'string', enum: 'pending' };
    const unionSchema: JsonSchemaMap = {
      type: ['string', 'null'],
      enum: [3, 6, 12],
    };

    cleanJsonSchema(malformedSchema);
    cleanJsonSchema(unionSchema);

    expect(malformedSchema.enum).toBeUndefined();
    expect(unionSchema.enum).toBeUndefined();
    expect(unionSchema.description).toContain('enum: 3, 6, 12');
    expect(unionSchema.type).toBe('string');
  });

  it('drops non-primitive enum members without emitting empty enums', () => {
    const stringSchema: JsonSchemaMap = { type: 'string', enum: [null, 'only'] };
    const objectSchema: JsonSchemaMap = { enum: [{ a: 1 }] };

    cleanJsonSchema(stringSchema);
    cleanJsonSchema(objectSchema);

    expect(stringSchema.enum).toEqual(['only']);
    expect(objectSchema.enum).toBeUndefined();
  });

  it('combines enum and validation hints into one constraint suffix', () => {
    const schema: JsonSchemaMap = {
      enum: [true, false],
      minimum: 1,
    };

    cleanJsonSchema(schema);

    expect(schema.description).toContain('enum: true, false');
    expect(schema.description).toContain('min: 1');
    expect((schema.description as string).match(/ \[Constraint: /g)).toHaveLength(1);
  });

  it('preserves numeric enums in nested array object properties', () => {
    const schema: JsonSchemaMap = {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              delay: { type: 'integer', enum: [3, 6, 12] },
            },
          },
        },
        groups: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              nested: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    delay: { type: 'integer', enum: [3, 6, 12] },
                  },
                },
              },
            },
          },
        },
      },
    };

    cleanJsonSchema(schema);

    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const actionDelay = (properties.actions.items as Record<string, Record<string, unknown>>)
      .properties.delay as Record<string, unknown>;
    const nestedDelay = (
      (
        (properties.groups.items as Record<string, Record<string, unknown>>).properties
          .nested as Record<string, unknown>
      ).items as Record<string, Record<string, unknown>>
    ).properties.delay as Record<string, unknown>;

    expect(actionDelay.enum).toEqual(['3', '6', '12']);
    expect(actionDelay.description).toBeUndefined();
    expect(nestedDelay.enum).toEqual(['3', '6', '12']);
    expect(nestedDelay.description).toBeUndefined();
  });

  it('normalizes every enum member in realistic tool parameters to a string', () => {
    const schema = normalizeObjectJsonSchema({
      type: 'object',
      properties: {
        command: { type: 'string', enum: [1, 2] },
        retry: { type: 'integer', enum: [0, 1] },
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: [null, 'safe'] },
            },
          },
        },
      },
    });

    const assertEnumMembersAreStrings = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(assertEnumMembersAreStrings);
        return;
      }
      if (!value || typeof value !== 'object') {
        return;
      }

      const objectValue = value as Record<string, unknown>;
      if (Array.isArray(objectValue.enum)) {
        expect(objectValue.enum.every((enumValue) => typeof enumValue === 'string')).toBe(true);
      }
      Object.values(objectValue).forEach(assertEnumMembersAreStrings);
    };

    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.retry.enum).toEqual(['0', '1']);
    assertEnumMembersAreStrings(schema);
  });
});
