import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';
import { SchemaConversionBatch } from '@/modules/proxy-gateway/antigravity/schema/SchemaConversion';
import {
  prepareResponseFormat,
  reportSchemaIssues,
} from '@/modules/proxy-gateway/antigravity/schema/SchemaPreparation';
import type { OpenAIChatRequest } from '../../../common/interfaces/request-interfaces';
import { convertOpenAIToolsToAnthropicTools } from './openai-claude-conversion';

export interface PreparedOpenAISchemas {
  schemas: Pick<ClaudeRequest, 'tools' | 'response_format'>;
  batch: SchemaConversionBatch;
}

export function prepareOpenAIRequestSchemas(
  request: Pick<OpenAIChatRequest, 'tools' | 'response_format'>,
  protocol: 'openai' | 'responses',
): PreparedOpenAISchemas {
  const batch = new SchemaConversionBatch();
  try {
    const schemas: Pick<ClaudeRequest, 'tools' | 'response_format'> = {
      tools: convertOpenAIToolsToAnthropicTools(request.tools, batch),
      response_format: prepareResponseFormat(request.response_format, batch),
    };
    return { schemas, batch };
  } finally {
    reportSchemaIssues(batch, protocol);
  }
}
