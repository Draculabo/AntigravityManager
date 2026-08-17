import { describe, expect, it } from 'vitest';

import {
  cleanJsonSchema,
  normalizeObjectJsonSchema,
} from '@/modules/proxy-gateway/antigravity/JsonSchemaUtils';

describe('cleanJsonSchema', () => {
  it('drops nested boolean sub-schemas and their required entries', () => {
    const schema: Record<string, unknown> = {
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

  it('preserves string enums without rewriting them', () => {
    const enumValues = ['pending', 'running', 'complete'];
    const schema = { type: 'string', enum: enumValues };

    cleanJsonSchema(schema);

    expect(schema.enum).toBe(enumValues);
  });

  it('stringifies primitive enum members only for string schemas', () => {
    const schema = { type: 'string', enum: [3, 6, 12] };

    cleanJsonSchema(schema);

    expect(schema.enum).toEqual(['3', '6', '12']);
  });

  it('removes non-string enums from non-string or untyped schemas and preserves their values as hints', () => {
    const integerSchema: Record<string, unknown> = { type: 'integer', enum: [3, 6, 12] };
    const untypedSchema: Record<string, unknown> = { enum: [true, false] };

    cleanJsonSchema(integerSchema);
    cleanJsonSchema(untypedSchema);

    expect(integerSchema.enum).toBeUndefined();
    expect(integerSchema.description).toContain('enum: 3, 6, 12');
    expect(untypedSchema.enum).toBeUndefined();
    expect(untypedSchema.description).toContain('enum: true, false');
  });

  it('removes malformed enums and does not coerce union-type enums', () => {
    const malformedSchema: Record<string, unknown> = { type: 'string', enum: 'pending' };
    const unionSchema: Record<string, unknown> = {
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
    const stringSchema: Record<string, unknown> = { type: 'string', enum: [null, 'only'] };
    const objectSchema: Record<string, unknown> = { enum: [{ a: 1 }] };

    cleanJsonSchema(stringSchema);
    cleanJsonSchema(objectSchema);

    expect(stringSchema.enum).toEqual(['only']);
    expect(objectSchema.enum).toBeUndefined();
  });

  it('combines enum and validation hints into one constraint suffix', () => {
    const schema: Record<string, unknown> = {
      type: 'integer',
      enum: [3, 6, 12],
      minimum: 1,
    };

    cleanJsonSchema(schema);

    expect(schema.description).toContain('enum: 3, 6, 12');
    expect(schema.description).toContain('min: 1');
    expect((schema.description as string).match(/ \[Constraint: /g)).toHaveLength(1);
  });

  it('cleans numeric enums in nested array object properties', () => {
    const schema: Record<string, unknown> = {
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

    expect(actionDelay.enum).toBeUndefined();
    expect(actionDelay.description).toContain('enum: 3, 6, 12');
    expect(nestedDelay.enum).toBeUndefined();
    expect(nestedDelay.description).toContain('enum: 3, 6, 12');
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

    assertEnumMembersAreStrings(schema);
  });
});
