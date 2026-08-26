import { describe, expect, it } from 'vitest';
import { cleanJsonSchema } from '@/modules/proxy-gateway/antigravity/JsonSchemaUtils';

/**
 * Gemini rejects `allOf`, `anyOf` and `oneOf`, so the sanitiser removes them. Removing the
 * keyword also removes the only place many MCP tool schemas declare their shape, and the tool
 * then reaches upstream with no properties at all. The shape has to be collapsed into the node
 * before the keyword is dropped.
 */
describe('JSON schema branch collapse', () => {
  it('keeps properties declared only inside anyOf', () => {
    const schema = {
      type: 'object',
      anyOf: [{ type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }],
    };

    cleanJsonSchema(schema);

    expect(schema).not.toHaveProperty('anyOf');
    expect((schema as Record<string, any>).properties?.city?.type).toBe('string');
    expect((schema as Record<string, any>).required).toEqual(['city']);
  });

  it('merges every allOf branch and unions required', () => {
    const schema = {
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
    const schema = {
      type: 'object',
      properties: { city: { type: 'string', description: 'declared on the node' } },
      oneOf: [{ properties: { city: { type: 'number' } } }],
    };

    cleanJsonSchema(schema);

    const map = schema as Record<string, any>;
    expect(map.properties.city.type).toBe('string');
    expect(map.properties.city.description).toBe('declared on the node');
  });

  it('leaves a schema without branches untouched', () => {
    const schema = { type: 'object', properties: { city: { type: 'string' } } };

    cleanJsonSchema(schema);

    expect((schema as Record<string, any>).properties.city.type).toBe('string');
  });
});
