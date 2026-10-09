import {
  SchemaConversionBatch,
  SchemaInputError,
} from '@/modules/proxy-gateway/antigravity/schema/SchemaConversion';
import { reportSchemaIssues } from '@/modules/proxy-gateway/antigravity/schema/SchemaPreparation';
import { z } from 'zod';
import type {
  OpenAIChatRequest,
  OpenAIResponseFormat,
} from '../../../common/interfaces/request-interfaces';

const JsonSchemaObjectSchema = z.record(z.string(), z.unknown());
const OpenAIJsonSchemaEnvelopeSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  schema: JsonSchemaObjectSchema,
  strict: z.boolean().optional(),
});
const OpenAIChatJsonSchemaResponseFormatSchema = z.object({
  type: z.literal('json_schema'),
  json_schema: OpenAIJsonSchemaEnvelopeSchema,
});
const ResponsesTextFormatTypeSchema = z.object({
  type: z.string(),
});
const ResponsesJsonSchemaFormatSchema = z.object({
  type: z.literal('json_schema'),
  name: z.string().optional(),
  description: z.string().optional(),
  schema: JsonSchemaObjectSchema,
  strict: z.boolean().optional(),
});

function rejectResponseFormat(protocol: 'openai' | 'responses'): never {
  const batch = new SchemaConversionBatch();
  batch.issue('invalid-input', false, null);
  reportSchemaIssues(batch, protocol);
  throw new SchemaInputError(
    'invalid-input',
    'Invalid response_format: json_schema must include an object schema and typed optional fields',
  );
}

export function validateOpenAIResponseFormat(request: OpenAIChatRequest): void {
  const responseFormat = request.response_format;
  if (!responseFormat || responseFormat.type !== 'json_schema') {
    return;
  }

  const parsed = OpenAIChatJsonSchemaResponseFormatSchema.safeParse(responseFormat);
  if (!parsed.success) {
    rejectResponseFormat('openai');
  }
}

export function toResponsesOpenAIResponseFormat(value: unknown): OpenAIResponseFormat | undefined {
  const formatType = ResponsesTextFormatTypeSchema.safeParse(value);
  if (!formatType.success) {
    return undefined;
  }

  if (formatType.data.type !== 'json_schema') {
    return { type: formatType.data.type };
  }

  const jsonSchemaFormat = ResponsesJsonSchemaFormatSchema.safeParse(value);
  if (!jsonSchemaFormat.success) {
    rejectResponseFormat('responses');
  }

  const { data } = jsonSchemaFormat;
  return {
    type: 'json_schema',
    json_schema: {
      name: data.name,
      description: data.description,
      schema: data.schema,
      strict: data.strict,
    },
  };
}
