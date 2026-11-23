import { describe, expect, it } from 'vitest';
import {
  cleanJsonSchema,
  type JsonSchemaMap,
} from '@/modules/proxy-gateway/antigravity/JsonSchemaUtils';

/**
 * Gemini rejects `allOf`, `anyOf` and `oneOf`, so the sanitiser removes them. Removing the
 * keyword also removes the only place many MCP tool schemas declare their shape, and the tool
 * then reaches upstream with no properties at all. The shape has to be collapsed into the node
 * before the keyword is dropped.
 */
describe('JSON schema branch collapse', () => {
  it.each(['anyOf', 'oneOf'])('keeps every object alternative in %s without requiring branch-specific fields', (keyword) => {
    const schema: JsonSchemaMap = {
      type: 'object',
      required: ['workspace'],
      properties: { workspace: { type: 'string' } },
      [keyword]: [
        {
          type: 'object',
          required: ['kind', 'path'],
          properties: { kind: { const: 'file' }, path: { type: 'string' } },
        },
        {
          type: 'object',
          required: ['kind', 'url'],
          properties: { kind: { const: 'remote' }, url: { type: 'string' } },
        },
      ],
    };

    cleanJsonSchema(schema);

    expect(schema).toEqual({
      type: 'object',
      required: ['workspace', 'kind'],
      properties: {
        workspace: { type: 'string' },
        kind: { type: 'string', enum: ['file', 'remote'] },
        path: { type: 'string' },
        url: { type: 'string' },
      },
    });
  });

  it('keeps properties declared only inside anyOf', () => {
    const schema: JsonSchemaMap = {
      type: 'object',
      anyOf: [{ type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }],
    };

    cleanJsonSchema(schema);

    expect(schema).not.toHaveProperty('anyOf');
    expect((schema as Record<string, any>).properties?.city?.type).toBe('string');
    expect((schema as Record<string, any>).required).toEqual(['city']);
  });

  it('leaves a shared free field open when another branch constrains it', () => {
    const schema: JsonSchemaMap = {
      oneOf: [
        { properties: { mode: { enum: ['fixed'] } }, required: ['mode'] },
        { properties: { mode: { type: 'string' } }, required: ['mode'] },
      ],
    };

    cleanJsonSchema(schema);

    expect(schema).toEqual({
      type: 'object',
      properties: { mode: { type: 'string' } },
      required: ['mode'],
    });
  });

  it('preserves array item alternatives and typed fallbacks for incompatible properties', () => {
    const schema: JsonSchemaMap = {
      oneOf: [
        { properties: {
          targets: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' } } } },
          key: { type: 'integer' },
          constructor: { type: 'string' },
        } },
        { properties: {
          targets: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' } } } },
          key: { type: 'string' },
        } },
      ],
    };

    cleanJsonSchema(schema);

    expect(schema).toEqual({
      type: 'object',
      properties: {
        targets: { type: 'array', items: {
          type: 'object', properties: { path: { type: 'string' }, url: { type: 'string' } },
        } },
        key: { type: 'integer' },
        constructor: { type: 'string' },
      },
    });
  });

  it('merges every allOf branch and unions required', () => {
    const schema: JsonSchemaMap = {
      type: 'object',
      allOf: [
        { properties: { a: { type: 'string' } }, required: ['a'] },
        { properties: { b: { type: 'number' } }, required: ['b'] },
      ],
    };

    cleanJsonSchema(schema);

    expect(schema).not.toHaveProperty('allOf');
    const map = schema as Record<string, any>;
    expect(Object.keys(map.properties)).toEqual(['a', 'b']);
    expect(map.required.sort()).toEqual(['a', 'b']);
  });

  it('does not let a branch overwrite what the node already declares', () => {
    const schema: JsonSchemaMap = {
      type: 'object',
      properties: { city: { type: 'string', description: 'declared on the node' } },
      oneOf: [{ properties: { city: { type: 'number' } } }],
    };

    cleanJsonSchema(schema);

    const map = schema as Record<string, any>;
    expect(map.properties.city.type).toBe('string');
    expect(map.properties.city.description).toBe('declared on the node');
  });

  it('preserves a const discriminator while collapsing a union branch', () => {
    const schema: JsonSchemaMap = {
      type: 'object',
      properties: {
        target: {
          anyOf: [
            {
              type: 'object',
              properties: {
                type: { const: 'element' },
              },
              required: ['type'],
            },
          ],
        },
      },
    };

    cleanJsonSchema(schema);

    expect(schema).toEqual({
      type: 'object',
      properties: {
        target: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['element'] },
          },
          required: ['type'],
        },
      },
    });
  });

  it('leaves a schema without branches untouched', () => {
    const schema: JsonSchemaMap = { type: 'object', properties: { city: { type: 'string' } } };

    cleanJsonSchema(schema);

    expect((schema as Record<string, any>).properties.city.type).toBe('string');
  });
});
