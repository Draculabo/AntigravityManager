import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeObjectJsonSchema } from '../../../src/modules/proxy-gateway/antigravity/JsonSchemaUtils';
import { SchemaConversionBatch } from '../../../src/modules/proxy-gateway/antigravity/schema/SchemaConversion';

/** Retain only aggregate conversion evidence from actual client declarations. */
export function measureClientSchemas(input: unknown) {
  const tools = z.array(z.object({ name: z.string(), input_schema: z.unknown() })).parse(input);
  const batch = new SchemaConversionBatch();
  const digests = new Set<string>();
  const mcpServerSchemas = { codegraph: 0, memory: 0, sequentialThinking: 0 };
  for (const [ordinal, tool] of tools.entries()) {
    const converted = normalizeObjectJsonSchema(tool.input_schema, batch, 'tool', ordinal);
    digests.add(createHash('sha256').update(JSON.stringify(converted)).digest('hex'));
    mcpServerSchemas.codegraph += tool.name.startsWith('mcp__codegraph__') ? 1 : 0;
    mcpServerSchemas.memory += tool.name.startsWith('mcp__memory__') ? 1 : 0;
    mcpServerSchemas.sequentialThinking += tool.name.startsWith('mcp__sequential-thinking__')
      ? 1
      : 0;
  }
  return {
    schemas: tools.length,
    mcpSchemas: tools.filter((tool) => tool.name.startsWith('mcp__')).length,
    mcpServerSchemas,
    degraded: batch.degraded,
    nodes: batch.nodes,
    bytes: batch.bytes,
    schemaDigests: [...digests],
  };
}
