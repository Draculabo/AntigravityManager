import type { OpenAIResponseFormat, Tool } from '@/modules/proxy-gateway/antigravity/types';
import {
  buildToolConfig,
  ToolConfigurationError,
} from '@/modules/proxy-gateway/antigravity/ToolChoiceCompat';
import { SchemaConversionBatch } from '@/modules/proxy-gateway/antigravity/schema/SchemaConversion';
import {
  prepareResponseFormat,
  reportSchemaIssues,
} from '@/modules/proxy-gateway/antigravity/schema/SchemaPreparation';
import type { OpenAIChatRequest } from '../../../common/interfaces/request-interfaces';
import { convertOpenAIGenerationTools } from './openai-claude-conversion';

export interface PreparedOpenAISchemas {
  schemas: {
    tools?: Tool[];
    responseFormat?: OpenAIResponseFormat;
  };
  batch: SchemaConversionBatch;
}

export function validateOpenAIRequestTools(
  toolChoice: OpenAIChatRequest['tool_choice'],
  schemas: PreparedOpenAISchemas['schemas'],
  protocol: 'openai' | 'responses',
): void {
  const config = buildToolConfig(toolChoice, schemas.tools ?? []);
  if (
    protocol === 'responses' &&
    schemas.responseFormat?.type === 'json_schema' &&
    config.functionCallingConfig?.mode === 'ANY'
  ) {
    throw new ToolConfigurationError('required-with-json-schema');
  }
}

export function prepareOpenAIRequestSchemas(
  request: Pick<OpenAIChatRequest, 'tools' | 'response_format'>,
  protocol: 'openai' | 'responses',
): PreparedOpenAISchemas {
  const batch = new SchemaConversionBatch();
  try {
    const schemas: PreparedOpenAISchemas['schemas'] = {
      tools: convertOpenAIGenerationTools(request.tools, batch),
      responseFormat: prepareResponseFormat(request.response_format, batch),
    };
    return { schemas, batch };
  } finally {
    reportSchemaIssues(batch, protocol);
  }
}
