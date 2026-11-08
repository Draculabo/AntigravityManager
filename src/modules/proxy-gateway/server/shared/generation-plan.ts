import { BadRequestException } from '@nestjs/common';
import { isDisabledThinkingEffort, parseModelEffort } from '../common/model-effort';

export type GenerationControlSource = 'gateway' | 'client';
export type ThinkingPlan =
  | { kind: 'disabled' }
  | { kind: 'adaptive' }
  | { kind: 'budget'; budget: number }
  | { kind: 'level'; level: string };

export interface GenerationPlanInput {
  source: GenerationControlSource;
  imageGeneration?: boolean;
  model: string;
  clientDisabled?: boolean;
  clientBudget?: number;
  clientEffort?: string;
  gatewayThinkingBudget?: number;
  registeredThinkingBudget?: number;
  registeredMaxOutputTokens?: number;
  explicitMaxOutputTokens?: number;
  outputCap: number;
  thinkingCap: number;
  includeThoughts?: boolean;
}

export interface GenerationPlan {
  maxOutputTokens: number;
  thinking: ThinkingPlan;
  includeThoughts: boolean;
  adjustmentReasons: string[];
}

const LEVELS = new Set(['low', 'medium', 'high']);

/** Headroom added to a positive budget when the client sent no explicit output limit. */
const DEFAULT_OUTPUT_HEADROOM = 1_024;
const IMAGE_OUTPUT_HEADROOM = 2_048;
/** Headroom added when the client did send an explicit limit that cannot hold the budget. */
const EXPLICIT_OUTPUT_HEADROOM = 1_024;

export function resolveGenerationPlan(input: GenerationPlanInput): GenerationPlan {
  const reasons: string[] = [];
  const outputCap = positiveCap(input.outputCap, 'outputCap');
  const thinkingCap = nonNegativeCap(input.thinkingCap, 'thinkingCap');
  const requestedThinking = resolveThinking(input, reasons);
  const thinking = constrainThinking(requestedThinking, thinkingCap, reasons);
  const explicitMax = input.explicitMaxOutputTokens;
  const registeredMax = input.registeredMaxOutputTokens;
  const requestedMax = explicitMax ?? registeredMax;
  let maxOutputTokens = positiveIntegerOrDefault(requestedMax, outputCap);
  if (registeredMax !== undefined && registeredMax !== maxOutputTokens) {
    reasons.push('registered-output-constrained');
  }

  const defaultHeadroom = input.imageGeneration ? IMAGE_OUTPUT_HEADROOM : DEFAULT_OUTPUT_HEADROOM;
  let constrainedThinking = thinking;
  if (thinking.kind === 'budget' && thinking.budget > 0) {
    // No caller-supplied limit at all: derive one from the budget so a positive
    // thinking budget never has to share its output allowance.
    if (explicitMax === undefined) {
      maxOutputTokens = thinking.budget + Math.min(defaultHeadroom, outputCap - thinking.budget);
      reasons.push('output-derived-from-thinking-budget');
    }
    if (input.explicitMaxOutputTokens !== undefined && thinking.budget / 6 >= maxOutputTokens) {
      const reduced = Math.max(0, maxOutputTokens - 1024);
      constrainedThinking = { kind: 'budget', budget: reduced };
      reasons.push('thinking-budget-reduced-by-six-times-rule');
    } else if (maxOutputTokens <= thinking.budget) {
      // Image generation reserves more output only when the caller omitted its limit.
      const headroom =
        input.explicitMaxOutputTokens !== undefined ? EXPLICIT_OUTPUT_HEADROOM : defaultHeadroom;
      const raised = thinking.budget + Math.min(headroom, outputCap - thinking.budget);
      if (raised !== maxOutputTokens) {
        maxOutputTokens = raised;
        reasons.push('output-raised-for-thinking-budget');
      }
    }
  }

  maxOutputTokens = Math.min(maxOutputTokens, outputCap);
  if (
    constrainedThinking.kind === 'budget' &&
    (constrainedThinking.budget >= maxOutputTokens ||
      (maxOutputTokens === outputCap && constrainedThinking.budget > maxOutputTokens - 1024))
  ) {
    const outputReserve = Math.min(1024, Math.max(1, maxOutputTokens - 1));
    const adjustedBudget = Math.max(0, maxOutputTokens - outputReserve);
    if (adjustedBudget !== constrainedThinking.budget) {
      reasons.push('thinking-budget-kept-below-output');
    }
    return {
      maxOutputTokens,
      thinking: { kind: 'budget', budget: adjustedBudget },
      includeThoughts: input.includeThoughts ?? true,
      adjustmentReasons: reasons,
    };
  }

  return {
    maxOutputTokens,
    thinking: constrainedThinking,
    includeThoughts: input.includeThoughts ?? constrainedThinking.kind !== 'disabled',
    adjustmentReasons: reasons,
  };
}

function resolveThinking(input: GenerationPlanInput, reasons: string[]): ThinkingPlan {
  if (
    input.source === 'client' &&
    (input.clientDisabled || isDisabledThinkingEffort(input.clientEffort))
  ) {
    return { kind: 'disabled' };
  }
  if (input.source === 'client' && input.clientBudget !== undefined) {
    if (!Number.isSafeInteger(input.clientBudget) || input.clientBudget < -1) {
      throw new BadRequestException('thinking budget must be -1 or a non-negative safe integer');
    }
    if (input.clientBudget === 0) {
      return { kind: 'disabled' };
    }
    if (input.clientBudget === -1) {
      return { kind: 'adaptive' };
    }
    reasons.push('client-budget-takes-precedence-over-effort');
    return { kind: 'budget', budget: input.clientBudget };
  }
  const budget = input.source === 'gateway' ? input.gatewayThinkingBudget : undefined;
  if (budget !== undefined) {
    if (!Number.isSafeInteger(budget) || budget < -1) {
      throw new BadRequestException(
        'gateway thinking budget must be -1 or a non-negative safe integer',
      );
    }
    if (budget === 0) {
      throw new BadRequestException(
        'gateway thinking budget 0 is invalid; use -1 or a positive budget',
      );
    }
    if (budget === -1) {
      return { kind: 'adaptive' };
    }
    return { kind: 'budget', budget };
  }
  if (input.clientEffort !== undefined) {
    const effort = parseModelEffort(input.clientEffort);
    if (!effort || !LEVELS.has(effort)) {
      throw new BadRequestException(`Unsupported model effort "${input.clientEffort}"`);
    }
    return { kind: 'level', level: effort };
  }
  if (input.registeredThinkingBudget !== undefined) {
    if (
      !Number.isSafeInteger(input.registeredThinkingBudget) ||
      input.registeredThinkingBudget < -1
    ) {
      throw new BadRequestException('thinking budget must be -1 or a non-negative safe integer');
    }
    if (input.registeredThinkingBudget === -1) {
      return { kind: 'adaptive' };
    }
    if (input.registeredThinkingBudget === 0) {
      return { kind: 'disabled' };
    }
    return { kind: 'budget', budget: input.registeredThinkingBudget };
  }
  return { kind: 'adaptive' };
}

function constrainThinking(
  thinking: ThinkingPlan,
  thinkingCap: number,
  reasons: string[],
): ThinkingPlan {
  if (thinking.kind !== 'budget') {
    return thinking;
  }
  const budget = Math.min(thinking.budget, thinkingCap);
  if (budget !== thinking.budget) {
    reasons.push('thinking-budget-capped-by-account');
  }
  return { kind: 'budget', budget };
}

function positiveCap(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BadRequestException(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeCap(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BadRequestException(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BadRequestException('max output tokens must be a positive safe integer');
  }
  return value;
}
