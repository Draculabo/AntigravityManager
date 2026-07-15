import { describe, expect, it } from 'vitest';

import { cleanJsonSchema } from '@/modules/proxy-gateway/antigravity/JsonSchemaUtils';

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
});
