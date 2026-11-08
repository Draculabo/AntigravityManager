import { performance } from 'node:perf_hooks';

import type { GeminiInternalRequest } from '../../antigravity/types';
import { GenerationDeadlineExceededError } from './exceptions/generation-deadline.exception';
import { UpstreamRequestError } from './exceptions/upstream-request.exception';
import { generationDeadlineAt } from './generation-deadline';
import { throwIfRequestAborted } from './request-cancellation';

const RECOVERY_THINKING_BUDGET = 4_000;
const OUTPUT_RESERVE = 1_024;
const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';
const OVERLOAD_ERROR_DOMAINS = new Set([
  'cloudcode-pa.googleapis.com',
  'staging-cloudcode-pa.googleapis.com',
  'autopush-cloudcode-pa.googleapis.com',
  'generativelanguage.googleapis.com',
]);

function isExplicitOverload(error: unknown): error is UpstreamRequestError {
  if (
    !(error instanceof UpstreamRequestError) ||
    error.status === undefined ||
    !((error.status >= 500 && error.status <= 599) || error.status === 408)
  ) {
    return false;
  }

  const text = `${error.message}\n${error.body ?? ''}`;
  if (
    /\b(?:quota[_ -]?exhausted|quota exceeded|(?:model[_ -]?)?capacity[_ -]?exhausted|resource[_ -]?exhausted)\b/iu.test(
      text,
    ) ||
    error.details?.some((detail) =>
      ['QUOTA_EXHAUSTED', 'MODEL_CAPACITY_EXHAUSTED', 'RESOURCE_EXHAUSTED'].includes(
        detail.reason ?? '',
      ),
    )
  ) {
    return false;
  }

  return (
    /\boverloaded\b/iu.test(text) ||
    error.details?.some(
      (detail) =>
        detail.type === ERROR_INFO_TYPE &&
        detail.reason === 'MODEL_OVERLOADED' &&
        OVERLOAD_ERROR_DOMAINS.has(detail.domain ?? ''),
    ) === true
  );
}

export function createOverloadThinkingRecovery(options: {
  model: string;
  explicitThinking: boolean;
  physicalTarget: boolean;
  registeredBudget?: number;
}): OverloadThinkingRecovery {
  // Bare families acquire a recipe during routing; their final wire budget owns automatic mode.
  const model = options.model.trim().replace(/^models\//iu, '');
  const bareGeminiFamily = /^gemini-\d+(?:\.\d+)*-(?:flash|pro)$/iu.test(model);
  return new OverloadThinkingRecovery(
    !options.explicitThinking &&
      !options.physicalTarget &&
      !/(?:^|[-_.])(?:low|medium|high)(?:$|[-_.])/iu.test(model) &&
      !model.toLowerCase().includes('image') &&
      (options.registeredBudget === undefined ||
        options.registeredBudget === -1 ||
        bareGeminiFamily),
  );
}

/** One additional send per logical request; protocol owners preserve original client intent. */
export class OverloadThinkingRecovery {
  private attempted = false;

  public constructor(private readonly eligible: boolean) {}

  public admit(
    error: unknown,
    body: GeminiInternalRequest,
    signal?: AbortSignal,
    canRecover?: () => boolean,
    deadlineAt?: number,
  ): GeminiInternalRequest | undefined {
    throwIfRequestAborted(signal);
    const signalDeadline = generationDeadlineAt(signal);
    const deadline = Math.min(deadlineAt ?? Infinity, signalDeadline ?? Infinity);
    if (deadline <= performance.now()) {
      throw new GenerationDeadlineExceededError();
    }
    if (
      !this.eligible ||
      this.attempted ||
      !isExplicitOverload(error) ||
      canRecover?.() === false
    ) {
      return undefined;
    }

    const config = body.request.generationConfig;
    if (
      body.requestType === 'image_gen' ||
      config?.responseModalities?.some((modality) => modality.toLowerCase() === 'image') ||
      config?.thinkingConfig?.thinkingBudget !== -1 ||
      config.thinkingConfig.thinkingLevel !== undefined ||
      config.maxOutputTokens === undefined ||
      config.maxOutputTokens < RECOVERY_THINKING_BUDGET + OUTPUT_RESERVE
    ) {
      return undefined;
    }

    this.attempted = true;
    return {
      ...body,
      request: {
        ...body.request,
        generationConfig: {
          ...config,
          thinkingConfig: {
            ...config.thinkingConfig,
            thinkingBudget: RECOVERY_THINKING_BUDGET,
          },
        },
      },
    };
  }
}
