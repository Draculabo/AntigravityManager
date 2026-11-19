import type { JsonSchema, Message, OpenAIResponseFormat, SystemPrompt, Tool } from './types';

type GenerationOutput = { kind: 'json-object' } | { kind: 'json-schema'; schema: JsonSchema };

export interface GenerationParameters {
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
}

export interface AntigravityGenerationInput {
  model: string;
  messages: Message[];
  system?: SystemPrompt;
  tools?: Tool[];
  toolChoice?: string | { type: string; name?: string; function?: { name: string } };
  signatureSessionKey?: string;
  thinking?: { type: string; budgetTokens?: number; effort?: string };
  outputEffort?: string;
  output?: GenerationOutput;
  parameters: GenerationParameters;
  /** Preserves the serialized generation config order used by existing clients. */
  thinkingAfterParameters?: true;
}

export function resolveGenerationOutput(
  format?: OpenAIResponseFormat,
): GenerationOutput | undefined {
  const type = String(format?.type ?? '').toLowerCase();
  if (type === 'json_object') {
    return { kind: 'json-object' };
  }
  if (type === 'json_schema' && format?.json_schema) {
    return { kind: 'json-schema', schema: format.json_schema.schema };
  }
  return undefined;
}
