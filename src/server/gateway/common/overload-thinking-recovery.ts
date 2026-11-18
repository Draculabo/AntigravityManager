import { performance } from 'node:perf_hooks';

import type { GeminiInternalRequest } from '../../../modules/proxy-gateway/antigravity/types';
import { GenerationDeadlineExceededError } from './exceptions/generation-deadline.exception';
import { UpstreamRequestError } from './exceptions/upstream-request.exception';
import { generationDeadlineAt } from './generation-deadline';
import { throwIfRequestAborted } from './request-cancellation';

const RECOVERY_THINKING_BUDGET = 4_000;
const OUTPUT_RESERVE = 1_024;
const GOOGLE_OVERLOAD_DOMAINS = new Set([
  'cloudcode-pa.googleapis.com',
  'staging-cloudcode-pa.googleapis.com',
  'autopush-cloudcode-pa.googleapis.com',
  'generativelanguage.googleapis.com',
]);
const CAPACITY_REASON = 'MODEL_CAPACITY_EXHAUSTED';
const LIMIT_REASONS = [CAPACITY_REASON, 'QUOTA_EXHAUSTED', 'RESOURCE_EXHAUSTED'];

type RecoveryKind = 'promote_capacity' | 'degrade_thinking';

function classify(error: UpstreamRequestError): RecoveryKind | undefined {
  const { status } = error;
  if (status === undefined || (status !== 408 && (status < 500 || status > 599))) {
    return undefined;
  }
  const text = `${error.message}\n${error.body ?? ''}`;
  const hasReason = (reason: string) => error.details?.some((detail) => detail.reason === reason);
  if (
    (status === 503 || status === 504) &&
    (hasReason(CAPACITY_REASON) ||
      /MODEL_CAPACITY_EXHAUSTED|no capacity available for model/iu.test(text))
  ) {
    return 'promote_capacity';
  }
  if (
    LIMIT_REASONS.some(hasReason) ||
    /\b(?:quota[_ -]?exhausted|quota exceeded|(?:model[_ -]?)?capacity[_ -]?exhausted|resource[_ -]?exhausted)\b/iu.test(
      text,
    )
  ) {
    return undefined;
  }
  if (
    status === 503 ||
    status === 529 ||
    /\boverloaded\b/iu.test(text) ||
    error.details?.some(
      (detail) =>
        detail.type === 'type.googleapis.com/google.rpc.ErrorInfo' &&
        detail.reason === 'MODEL_OVERLOADED' &&
        GOOGLE_OVERLOAD_DOMAINS.has(detail.domain ?? ''),
    )
  ) {
    return 'degrade_thinking';
  }
  return undefined;
}

function capacityTarget(model: string): string {
  if (/-high$/iu.test(model)) {
    return model;
  }
  const promoted = model.replace(/-(?:low|medium|tiered)$/iu, '-high');
  if (promoted !== model || !/^gemini-[\d.]+-(?:flash|pro)$/iu.test(model)) {
    return promoted;
  }
  return `${model}-high`;
}

/** Each transformation has one allowance across the logical request and its account fallbacks. */
export class OverloadThinkingRecovery {
  private readonly attempted = new Set<RecoveryKind>();

  public admit(
    error: unknown,
    body: GeminiInternalRequest,
    signal?: AbortSignal,
    canRecover?: () => boolean,
    deadlineAt?: number,
    canRecoverWithModel?: (model: string) => boolean,
  ): { kind: RecoveryKind; body: GeminiInternalRequest; delayMs: number } | undefined {
    throwIfRequestAborted(signal);
    const deadline = Math.min(deadlineAt ?? Infinity, generationDeadlineAt(signal) ?? Infinity);
    if (deadline <= performance.now()) {
      throw new GenerationDeadlineExceededError();
    }
    if (!(error instanceof UpstreamRequestError) || canRecover?.() === false) {
      return undefined;
    }
    const kind = classify(error);
    const config = body.request.generationConfig;
    if (
      kind === undefined ||
      this.attempted.has(kind) ||
      body.requestType === 'image_gen' ||
      /(?:^|-)image(?:-|$)/iu.test(body.model) ||
      config?.responseModalities?.some((modality) => modality.toLowerCase() === 'image')
    ) {
      return undefined;
    }

    const originalThinking = config?.thinkingConfig;
    const thinkingConfig = originalThinking ? { ...originalThinking } : undefined;
    let model = body.model;
    let thinkingChanged = false;
    if (kind === 'promote_capacity') {
      if (/^gemini-/iu.test(model)) {
        model = capacityTarget(model);
        if (model !== body.model && thinkingConfig && thinkingConfig.thinkingBudget !== 0) {
          thinkingChanged =
            thinkingConfig.thinkingLevel !== 'HIGH' || thinkingConfig.thinkingBudget !== undefined;
          delete thinkingConfig.thinkingBudget;
          thinkingConfig.thinkingLevel = 'HIGH';
        }
      }
    } else {
      if (thinkingConfig?.thinkingLevel?.toUpperCase() === 'HIGH') {
        thinkingConfig.thinkingLevel = 'MEDIUM';
        thinkingChanged = true;
      } else if (
        thinkingConfig &&
        !thinkingConfig.thinkingLevel &&
        (thinkingConfig.thinkingBudget === -1 ||
          (thinkingConfig.thinkingBudget ?? 0) > RECOVERY_THINKING_BUDGET ||
          (thinkingConfig.thinkingBudget === undefined &&
            thinkingConfig.includeThoughts === true)) &&
        (config?.maxOutputTokens ?? 0) >= RECOVERY_THINKING_BUDGET + OUTPUT_RESERVE
      ) {
        thinkingConfig.thinkingBudget = RECOVERY_THINKING_BUDGET;
        thinkingChanged = true;
      }
      if (/^gemini-/iu.test(model)) {
        model = model.replace(/-high$/iu, '-medium');
      }
    }
    // A provider context-cache resource is tied to the physical model that created it.
    if (
      model !== body.model &&
      (body.request.cachedContent || canRecoverWithModel?.(model) === false)
    ) {
      return undefined;
    }
    if (model === body.model && !thinkingChanged) {
      return undefined;
    }
    this.attempted.add(kind);
    return {
      kind,
      delayMs: kind === 'promote_capacity' ? 50 : 150,
      body: {
        ...body,
        model,
        request: thinkingConfig
          ? {
              ...body.request,
              generationConfig: { ...config, thinkingConfig },
            }
          : body.request,
      },
    };
  }
}
