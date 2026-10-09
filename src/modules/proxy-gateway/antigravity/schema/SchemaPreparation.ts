import { normalizeObjectJsonSchema } from '../JsonSchemaUtils';
import type { ClaudeRequest } from '../types';
import { logger } from '@/shared/logging/logger';
import { SchemaConversionBatch } from './SchemaConversion';

export interface PreparedSchemaState {
  schemasPrepared: true;
  cacheSchemas: boolean;
}

export function prepareClaudeSchemas(
  request: ClaudeRequest,
  batch: SchemaConversionBatch,
): ClaudeRequest {
  return {
    ...request,
    tools: request.tools?.map((tool, ordinal) => {
      if (
        ['web_search', 'google_search', 'builtin_web_search'].includes(tool.name) ||
        ['web_search_20250305', 'builtin_web_search'].includes(tool.type ?? '')
      ) {
        return { ...tool };
      }
      return {
        ...tool,
        input_schema: normalizeObjectJsonSchema(tool.input_schema, batch, 'tool', ordinal),
      };
    }),
    response_format: prepareResponseFormat(request.response_format, batch),
  };
}

export function prepareResponseFormat(
  format: ClaudeRequest['response_format'],
  batch: SchemaConversionBatch,
): ClaudeRequest['response_format'] {
  if (format?.type !== 'json_schema' || !format.json_schema) {
    return format;
  }
  return {
    ...format,
    json_schema: {
      ...format.json_schema,
      schema: normalizeObjectJsonSchema(format.json_schema.schema, batch, 'output'),
    },
  };
}

/** Fixed fields only. Isolated reporting excludes request data and surrounding logs. */
export function reportSchemaIssues(
  batch: SchemaConversionBatch,
  protocol: 'openai' | 'responses' | 'anthropic' | 'anthropic-count-tokens',
): void {
  if (batch.issueCount === 0) {
    return;
  }
  logger.diagnosticError(
    `Schema conversion issue ${JSON.stringify({ protocol, issueCount: batch.issueCount, degraded: batch.degraded, nodes: batch.nodes, bytes: batch.bytes, issues: batch.issues })}`,
  );
}

export function preparedSchemaState(batch: SchemaConversionBatch): PreparedSchemaState {
  return { schemasPrepared: true, cacheSchemas: !batch.degraded };
}
