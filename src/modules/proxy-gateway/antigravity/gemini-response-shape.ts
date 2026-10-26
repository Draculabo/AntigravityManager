import { isPlainObject } from 'lodash-es';

function record(value: unknown): value is { [key: string]: unknown } {
  return isPlainObject(value);
}

/** Validate only fields the generation consumers interpret; retain provider extensions. */
export function isGeminiGenerationShape(value: unknown): boolean {
  if (!record(value)) {
    return false;
  }
  if (
    !['candidates', 'usageMetadata', 'promptFeedback', 'modelVersion', 'responseId'].some(
      (key) => key in value,
    )
  ) {
    return false;
  }
  if (
    value.promptFeedback !== undefined &&
    (!record(value.promptFeedback) ||
      (value.promptFeedback.blockReason !== undefined &&
        typeof value.promptFeedback.blockReason !== 'string'))
  ) {
    return false;
  }
  if (value.usageMetadata !== undefined) {
    if (!record(value.usageMetadata)) {
      return false;
    }
    for (const key of [
      'promptTokenCount',
      'candidatesTokenCount',
      'totalTokenCount',
      'cachedContentTokenCount',
      'thoughtsTokenCount',
      'total_input_tokens',
      'total_output_tokens',
      'total_tokens',
      'total_cached_tokens',
      'total_thought_tokens',
      'totalThoughtTokens',
      'cachedTokens',
      'total_tool_use_tokens',
    ]) {
      const count = value.usageMetadata[key];
      if (
        count !== undefined &&
        (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
      ) {
        return false;
      }
    }
  }
  if (
    (value.modelVersion !== undefined && typeof value.modelVersion !== 'string') ||
    (value.responseId !== undefined && typeof value.responseId !== 'string')
  ) {
    return false;
  }
  if (value.candidates === undefined) {
    return true;
  }
  if (!Array.isArray(value.candidates)) {
    return false;
  }
  for (const candidate of value.candidates) {
    if (
      !record(candidate) ||
      (candidate.finishReason !== undefined && typeof candidate.finishReason !== 'string')
    ) {
      return false;
    }
    if (candidate.content === undefined) {
      continue;
    }
    if (
      !record(candidate.content) ||
      (candidate.content.parts !== undefined && !Array.isArray(candidate.content.parts))
    ) {
      return false;
    }
    for (const part of candidate.content.parts ?? []) {
      if (
        !record(part) ||
        (part.text !== undefined && typeof part.text !== 'string') ||
        (part.thought !== undefined && typeof part.thought !== 'boolean')
      ) {
        return false;
      }
      if (
        part.functionCall !== undefined &&
        (!record(part.functionCall) ||
          typeof part.functionCall.name !== 'string' ||
          (part.functionCall.args !== undefined && !record(part.functionCall.args)))
      ) {
        return false;
      }
      if (
        part.inlineData !== undefined &&
        (!record(part.inlineData) || typeof part.inlineData.data !== 'string')
      ) {
        return false;
      }
    }
  }
  return true;
}
