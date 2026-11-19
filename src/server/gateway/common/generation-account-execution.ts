import { performance } from 'node:perf_hooks';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { InvalidToolResultAssociationError } from '@/modules/proxy-gateway/antigravity/ClaudeToolResultAssociation';
import { UnsupportedGeminiFinishReasonError } from '@/modules/proxy-gateway/antigravity/GeminiFinishReason';
import { isTerminalGenerationFailure } from '@/modules/proxy-gateway/antigravity/UpstreamGenerationError';
import { getServerConfig } from '@/server/server-config';
import type { AccountLeaseService } from '../modules/account-lease/account-lease.service';
import type { InternalGenerationOptions } from '../modules/gemini/gemini-client.service';
import type {
  ImageRetryPenaltyMode,
  ProxyRetryService,
  ProxyTokenRetryState,
} from '../shared/services/proxy-retry.service';
import { isGeminiImageModel } from '../shared/services/rate-limit-tracker.service';
import { AggregationAdmissionError } from './aggregation-admission';
import { selectAuditedRetryAccount, type RetryAccountSelection } from './audited-retry-account';
import { CoworkCompactionControl } from './cowork-compaction-control';
import { GenerationDeadlineExceededError } from './exceptions/generation-deadline.exception';
import { UpstreamEndpointConfigurationError } from './exceptions/upstream-endpoint-configuration.exception';
import { generationDeadlineAt } from './generation-deadline';
import { InvalidGenerationHistoryError } from './generation-history';
import { admitGenerationProjectRecovery } from './generation-project-recovery';
import { getGenerationTimeoutMs } from './generation-timeout-policy';
import { InvalidThoughtSignatureModelError } from './invalid-thought-signature-model.exception';
import { OverloadThinkingRecovery } from './overload-thinking-recovery';
import { awaitRequestOperation, throwIfRequestAborted } from './request-cancellation';
import { createUpstreamSessionIdentity } from './upstream-session-identity';
import {
  isUpstreamSessionRecoveryFailure,
  type UpstreamSessionRecoveryBudget,
} from './upstream-session-recovery';
import { UpstreamThoughtSignatureConflictError } from './upstream-thought-signature-validation';

interface GenerationAccountPlan extends Omit<RetryAccountSelection, 'imageRequest'> {
  storeKey: string;
  physicalTarget: boolean;
  label: string;
  unavailableMessage?: string;
  exhaustedMessage?: string;
  retry:
    | { kind: 'anthropic'; allowImageGrace: boolean }
    | {
        kind: 'scheduled';
        imageRequest: boolean;
        allowImageGrace: boolean;
        imagePenaltyMode: ImageRetryPenaltyMode;
      };
}

type LeaseAccess = Pick<
  AccountLeaseService,
  | 'acceptLeaseCompletion'
  | 'getOrdinaryRetryWaitMs'
  | 'isLeaseEligible'
  | 'resolveDynamicModelForAccount'
>;

/** These failures must keep their identity across protocol-level fallbacks. */
export function throwIfTerminalGenerationFailure(error: unknown): void {
  if (
    isUpstreamSessionRecoveryFailure(error) ||
    error instanceof UnsupportedGeminiFinishReasonError ||
    isTerminalGenerationFailure(error) ||
    error instanceof InvalidGenerationHistoryError ||
    error instanceof UpstreamThoughtSignatureConflictError ||
    error instanceof InvalidThoughtSignatureModelError ||
    error instanceof InvalidToolResultAssociationError ||
    error instanceof UpstreamEndpointConfigurationError ||
    error instanceof GenerationDeadlineExceededError ||
    error instanceof CoworkCompactionControl
  ) {
    throw error;
  }
}

/** Owns one generation's account attempts and recovery budgets. */
export class GenerationAccountExecution {
  private readonly state: ProxyTokenRetryState;
  private readonly recoveryBudget: UpstreamSessionRecoveryBudget = { attempted: false };
  private readonly overloadThinkingRecovery = new OverloadThinkingRecovery();
  private readonly imageRequest: boolean;
  private projectDowngraded = false;
  private lastError: unknown = null;
  private repeatAttempt = false;

  constructor(
    private readonly retryPolicy: ProxyRetryService,
    private readonly leases: LeaseAccess,
    private readonly plan: GenerationAccountPlan,
  ) {
    this.state = retryPolicy.createTokenRetryState(
      getGenerationTimeoutMs(),
      plan.effort,
      plan.physicalTarget,
    );
    this.imageRequest = plan.retry.kind === 'scheduled' && plan.retry.imageRequest;
  }

  async *accounts(): AsyncGenerator<CloudAccount, void> {
    const { model, label, signal, effort, targetAccountId, retry } = this.plan;
    try {
      throwIfRequestAborted(signal);
      const maxAttempts = await awaitRequestOperation(
        this.retryPolicy.getMaxRetryAttempts(model, this.imageRequest, this.state, effort),
        signal,
      );
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (this.imageRequest) {
          await this.retryPolicy.waitBeforeRetry(
            attempt,
            maxAttempts,
            label,
            this.state.graceRetryToken !== null,
          );
        }
        if (retry.kind === 'anthropic') {
          throwIfRequestAborted(signal);
        }
        const token = await selectAuditedRetryAccount(this.retryPolicy, this.state, {
          ...this.plan,
          imageRequest: this.imageRequest,
        });
        if (!token) {
          if (targetAccountId) {
            throw new Error(
              `Target account '${targetAccountId}' is unavailable or does not support model '${model}'`,
            );
          }
          if (this.lastError !== null) {
            throw this.retryPolicy.resolveTerminalError(this.state, this.lastError);
          }
          throw new Error(
            this.plan.unavailableMessage ?? 'No available accounts (all exhausted or rate limited)',
          );
        }
        yield token;
        if (this.state.abortRetry) {
          break;
        }
        if (this.repeatAttempt) {
          this.repeatAttempt = false;
          attempt -= 1;
        }
      }
    } finally {
      this.releaseImagePermit();
    }
  }

  exhaustedError(): unknown {
    return this.retryPolicy.resolveTerminalError(
      this.state,
      this.lastError || new Error(this.plan.exhaustedMessage ?? 'Request failed after retries'),
    );
  }

  modelFor(token: CloudAccount): string {
    const { model, effort, physicalTarget } = this.plan;
    return this.leases.resolveDynamicModelForAccount(token.id, model, effort, physicalTarget);
  }

  upstreamOptions(token: CloudAccount): InternalGenerationOptions {
    const { signal, storeKey } = this.plan;
    this.recoveryBudget.deadlineAt ??=
      generationDeadlineAt(signal) ?? performance.now() + getGenerationTimeoutMs();
    this.recoveryBudget.thinkingOnlyEnabled ??=
      getServerConfig()?.experimental?.thinking_only_recovery ?? true;
    return {
      recoveryAccountId: token.id,
      recoveryBudget: this.recoveryBudget,
      upstreamSession: createUpstreamSessionIdentity(token.id, storeKey),
      canRecoverUpstreamSession: () => this.leases.isLeaseEligible(token),
      canRecoverWithModel: (model) =>
        this.leases.getOrdinaryRetryWaitMs({ model, accountId: token.id, physicalTarget: true }) ===
        0,
      overloadThinkingRecovery: this.overloadThinkingRecovery,
    };
  }

  admitProjectDowngrade(error: unknown, project: string | undefined): boolean {
    if (
      this.retryPolicy.isFatalCircuitBreakError(error) ||
      this.projectDowngraded ||
      !project?.trim() ||
      !admitGenerationProjectRecovery(error, this.plan.signal, project)
    ) {
      return false;
    }
    this.projectDowngraded = true;
    return true;
  }

  takeImagePermit() {
    return this.retryPolicy.takeImagePermit(this.state);
  }

  releaseImagePermit(): void {
    this.retryPolicy.releaseImagePermit(this.state);
  }

  async fail(token: CloudAccount, model: string, error: unknown): Promise<void> {
    if (
      error instanceof AggregationAdmissionError ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      throw error;
    }
    this.lastError = error;
    this.retryPolicy.recordFailure(this.state, error);
    const { label, signal, effort, retry, targetAccountId } = this.plan;
    const penalize = () =>
      this.retryPolicy.applyUpstreamPenalty(
        token.id,
        model,
        error,
        () => this.leases.acceptLeaseCompletion(token),
        effort,
      );
    if (this.state.abortRetry) {
      this.releaseImagePermit();
      await penalize();
      return;
    }
    if (retry.kind === 'scheduled' && retry.imageRequest) {
      this.repeatAttempt = await this.retryPolicy.prepareScheduledImageRetry(
        this.state,
        token,
        model,
        error,
        label,
        retry.allowImageGrace,
        signal,
        retry.imagePenaltyMode,
      );
      return;
    }

    const penaltyBeforeGrace =
      retry.kind === 'scheduled' &&
      this.retryPolicy.shouldRecordImagePenaltyBeforeGrace(model, error);
    if (penaltyBeforeGrace) {
      await penalize();
    }
    const imageModel = isGeminiImageModel(this.plan.model);
    if (
      (retry.kind === 'scheduled' || retry.allowImageGrace || !imageModel) &&
      (await this.retryPolicy.prepareGraceRetry(
        this.state,
        token,
        error,
        label,
        retry.kind === 'anthropic' ? 'anthropic' : 'hinted',
        signal,
      ))
    ) {
      this.repeatAttempt = retry.kind === 'scheduled' || !imageModel;
      return;
    }
    if (!penaltyBeforeGrace) {
      await penalize();
    }
    if (targetAccountId) {
      throw this.retryPolicy.resolveTerminalError(
        this.state,
        error || new Error(`Request failed for target account '${targetAccountId}'`),
      );
    }
  }
}
