import { auditJsonObject, type AuditJsonObject } from './audit-json-object';

export interface AuditUsage {
  cachedTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

function readNumber(value: AuditJsonObject | null, keys: readonly string[]): number | undefined {
  if (!value) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Later events override only fields they actually report. */
export function mergeAuditUsage(
  previous: AuditUsage | undefined,
  next: AuditUsage | undefined,
): AuditUsage | undefined {
  if (!next) {
    return previous;
  }
  return {
    ...previous,
    ...(next.cachedTokens !== undefined ? { cachedTokens: next.cachedTokens } : {}),
    ...(next.inputTokens !== undefined ? { inputTokens: next.inputTokens } : {}),
    ...(next.outputTokens !== undefined ? { outputTokens: next.outputTokens } : {}),
    ...(next.reasoningTokens !== undefined ? { reasoningTokens: next.reasoningTokens } : {}),
  };
}

function directUsage(source: AuditJsonObject): AuditUsage | undefined {
  const usage = auditJsonObject(source.usage) ?? auditJsonObject(source.usageMetadata);
  if (!usage) {
    return undefined;
  }
  const promptDetails =
    auditJsonObject(usage.prompt_tokens_details) ?? auditJsonObject(usage.input_tokens_details);
  const outputDetails =
    auditJsonObject(usage.output_tokens_details) ??
    auditJsonObject(usage.completion_tokens_details);
  const result: AuditUsage = {
    cachedTokens:
      readNumber(usage, [
        'total_cached_tokens',
        'cached_tokens',
        'cachedContentTokenCount',
        'cachedTokens',
        'cache_read_input_tokens',
      ]) ?? readNumber(promptDetails, ['cached_tokens']),
    inputTokens: readNumber(usage, [
      'total_input_tokens',
      'input_tokens',
      'prompt_tokens',
      'promptTokenCount',
    ]),
    outputTokens: readNumber(usage, [
      'total_output_tokens',
      'output_tokens',
      'completion_tokens',
      'candidatesTokenCount',
    ]),
    reasoningTokens:
      readNumber(usage, [
        'total_thought_tokens',
        'totalThoughtTokens',
        'reasoning_tokens',
        'thoughtsTokenCount',
      ]) ?? readNumber(outputDetails, ['reasoning_tokens']),
  };
  return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

/** Reads the actual gateway response and streaming-event wrappers without summing cache/reasoning twice. */
export function extractAuditUsage(value: unknown, depth = 0): AuditUsage | undefined {
  if (depth > 8) {
    return undefined;
  }
  const source = auditJsonObject(value);
  if (!source) {
    return undefined;
  }
  let result: AuditUsage | undefined;
  if (Array.isArray(source.events)) {
    for (const event of source.events) {
      result = mergeAuditUsage(result, extractAuditUsage(event, depth + 1));
    }
  }
  result = mergeAuditUsage(result, extractAuditUsage(source.response, depth + 1));
  result = mergeAuditUsage(result, extractAuditUsage(source.message, depth + 1));
  return mergeAuditUsage(result, directUsage(source));
}
