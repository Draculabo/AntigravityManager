import modelSpecsJson from './model-specs';
import { isNumber } from 'lodash-es';

type ModelSpec = {
  max_output_tokens?: number;
  thinking_budget?: number;
  is_thinking?: boolean;
};

type SpecsConfig = {
  models: Record<string, ModelSpec>;
  aliases: Record<string, string>;
};

const DEFAULT_MAX_OUTPUT_TOKENS = 65535;
const DEFAULT_THINKING_BUDGET = 24576;

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

export function getThinkingBudget(modelId: string): number {
  const resolved = resolveModelAlias(modelId);
  const fromSpec = SPECS.models[resolved]?.thinking_budget;
  if (isNumber(fromSpec) && Number.isFinite(fromSpec) && fromSpec >= 0) {
    return Math.floor(fromSpec);
  }
  return DEFAULT_THINKING_BUDGET;
}
