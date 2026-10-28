import modelSpecsJson from './model-specs';
import { isNumber } from 'lodash-es';

type ModelSpec = {
  context_window?: number;
  max_output_tokens?: number;
  thinking_budget?: number;
  is_thinking?: boolean;
};

type SpecsConfig = {
  models: Record<string, ModelSpec>;
  aliases: Record<string, string>;
};

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 65535;
const DEFAULT_THINKING_BUDGET = 24576;
const CLAUDE_CONTEXT_WINDOW = 200_000;
const GEMINI_CONTEXT_WINDOW = 1_048_576;

const SPECS = modelSpecsJson as SpecsConfig;

export function resolveModelAlias(modelId: string): string {
  const normalized = modelId.trim();
  return SPECS.aliases[normalized] ?? normalized;
}

export function getMaxOutputTokens(modelId: string): number {
  const resolved = resolveModelAlias(modelId);
  const fromSpec = SPECS.models[resolved]?.max_output_tokens;
  if (isNumber(fromSpec) && Number.isFinite(fromSpec) && fromSpec > 0) {
    return Math.floor(fromSpec);
  }
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * Input context the gateway publishes for a model. The static spec catalog owns the
 * provider-declared window; a dynamic route the catalog has not seen yet falls back to its
 * family width so a newer Gemini or Claude generation is not under-reported as a small model.
 */
export function getContextWindow(modelId: string): number {
  const resolved = resolveModelAlias(modelId);
  const fromSpec = SPECS.models[resolved]?.context_window;
  if (isNumber(fromSpec) && Number.isFinite(fromSpec) && fromSpec > 0) {
    return Math.floor(fromSpec);
  }
  return getFamilyContextWindow(resolved);
}

function getFamilyContextWindow(modelId: string): number {
  const normalized = modelId.trim().toLowerCase();
  if (normalized.includes('claude')) {
    return CLAUDE_CONTEXT_WINDOW;
  }
  if (normalized.includes('gemini')) {
    return GEMINI_CONTEXT_WINDOW;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

export function getThinkingBudget(modelId: string): number {
  const resolved = resolveModelAlias(modelId);
  const fromSpec = SPECS.models[resolved]?.thinking_budget;
  if (isNumber(fromSpec) && Number.isFinite(fromSpec) && fromSpec >= 0) {
    return Math.floor(fromSpec);
  }
  return DEFAULT_THINKING_BUDGET;
}
