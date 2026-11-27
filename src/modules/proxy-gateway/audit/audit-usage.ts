import { auditJsonObject, type AuditJsonObject } from './audit-json-object';

export interface AuditUsage {
  cachedTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

interface UpstreamUsageObservation {
  usage?: AuditUsage;
  candidates?: number;
  thoughts?: number;
  total?: number;
  toolPrompt?: number;
}

function readNumber(value: AuditJsonObject | null, keys: readonly string[]): number | undefined {
  if (!value) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0) {
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

function observeUpstreamUsage(source: AuditJsonObject): UpstreamUsageObservation | undefined {
  const usage = directUsage(source);
  const gemini = auditJsonObject(source.usage) ?? auditJsonObject(source.usageMetadata);
  const candidates = readNumber(gemini, ['total_output_tokens', 'candidatesTokenCount']);
  const thoughts = readNumber(gemini, ['total_thought_tokens', 'thoughtsTokenCount']);
  const total = readNumber(gemini, ['total_tokens', 'totalTokenCount']);
  const toolPrompt = readNumber(gemini, ['total_tool_use_tokens', 'toolUsePromptTokenCount']);
  return [usage, candidates, thoughts, total, toolPrompt].some((value) => value !== undefined)
    ? { usage, candidates, thoughts, total, toolPrompt }
    : undefined;
}

export function mergeUpstreamUsage(
  previous: UpstreamUsageObservation | undefined,
  next: UpstreamUsageObservation | undefined,
): UpstreamUsageObservation | undefined {
  if (!previous || !next) {
    return next ?? previous;
  }
  return {
    usage: mergeAuditUsage(previous.usage, next.usage),
    candidates: next.candidates ?? previous.candidates,
    thoughts: next.thoughts ?? previous.thoughts,
    total: next.total ?? previous.total,
    toolPrompt: next.toolPrompt ?? previous.toolPrompt,
  };
}

/** Fold independently reported Gemini counters only when the provider total reconciles them. */
export function normalizeUpstreamUsage(
  observation: UpstreamUsageObservation | undefined,
): AuditUsage | undefined {
  if (!observation) {
    return undefined;
  }
  const { usage, candidates, thoughts, total, toolPrompt = 0 } = observation;
  if (
    usage?.inputTokens === undefined ||
    candidates === undefined ||
    usage.outputTokens !== candidates
  ) {
    return usage;
  }
  const inputTokens = usage.inputTokens + toolPrompt;
  const inclusiveTotal = inputTokens + candidates;
  if (total === inclusiveTotal && toolPrompt > 0) {
    return { ...usage, inputTokens };
  }
  if (
    thoughts !== undefined &&
    usage.reasoningTokens === thoughts &&
    total === inclusiveTotal + thoughts
  ) {
    return { ...usage, inputTokens, outputTokens: candidates + thoughts };
  }
  return usage;
}

function readUsage<T>(
  value: unknown,
  read: (source: AuditJsonObject) => T | undefined,
  merge: (previous: T | undefined, next: T | undefined) => T | undefined,
  depth: number,
): T | undefined {
  if (depth > 8) {
    return undefined;
  }
  const source = auditJsonObject(value);
  if (!source) {
    return undefined;
  }
  let result: T | undefined;
  if (Array.isArray(source.events)) {
    for (const event of source.events) {
      result = merge(result, readUsage(event, read, merge, depth + 1));
    }
  }
  result = merge(result, readUsage(source.response, read, merge, depth + 1));
  result = merge(result, readUsage(source.message, read, merge, depth + 1));
  return merge(result, read(source));
}

/** Reads the actual gateway response and streaming-event wrappers. */
export function extractAuditUsage(value: unknown): AuditUsage | undefined {
  return readUsage(value, directUsage, mergeAuditUsage, 0);
}

/** Normalizes raw provider counters for one physical attempt before persistence. */
export function extractUpstreamAuditUsage(value: unknown): AuditUsage | undefined {
  return normalizeUpstreamUsage(extractUpstreamUsageObservation(value));
}

export function extractUpstreamUsageObservation(
  value: unknown,
): UpstreamUsageObservation | undefined {
  return readUsage(value, observeUpstreamUsage, mergeUpstreamUsage, 0);
}
