import { Inject, Injectable } from '@nestjs/common';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { isNumber, isString } from 'lodash-es';
import { getMaxOutputTokens, getThinkingBudget } from '../../../antigravity/ModelSpecs';
import type { GeminiInternalRequest } from '../../../antigravity/types';
import { resolveGenerationPlan } from '../generation-plan';

/**
 * Injection token for the account-side capability reader. A token rather than the concrete
 * `AccountLeaseService` keeps `shared/` free of an import back into `modules/account-lease/`.
 */
export const PROXY_MODEL_CAPABILITY_READER = 'PROXY_MODEL_CAPABILITY_READER';

export interface ProxyModelCapabilityReader {
  getModelOutputLimitForAccount(accountId: string, modelName: string): number | undefined;
  getModelThinkingBudgetForAccount(accountId: string, modelName: string): number | undefined;
}

export interface RegisteredGenerationConstraints {
  thinkingBudget: number;
  maxOutputTokens: number;
  includeThoughts: boolean;
}

@Injectable()
export class GenerationConstraintsService {
  constructor(
    @Inject(PROXY_MODEL_CAPABILITY_READER)
    private readonly modelCapabilities: ProxyModelCapabilityReader,
  ) {}

  applyInternalGenerationConstraints(
    body: GeminiInternalRequest,
    model: string,
    accountId: string,
    registered?: RegisteredGenerationConstraints,
    enforceAuthoritativeThinkingBudget = false,
  ): void {
    let generationConfig = body.request.generationConfig;
    if (!generationConfig) {
      if (!registered && !enforceAuthoritativeThinkingBudget) {
        return;
      }
      generationConfig = {};
      body.request.generationConfig = generationConfig;
    }

    if (registered) {
      const registeredPlan = resolveGenerationPlan({
        source: 'gateway',
        model,
        registeredThinkingBudget:
          this.resolveConfiguredThinkingBudget(model) ?? registered.thinkingBudget,
        registeredMaxOutputTokens: registered.maxOutputTokens,
        outputCap: this.getModelOutputCap(accountId, model),
        thinkingCap: this.getModelThinkingBudget(accountId, model),
        includeThoughts: registered.includeThoughts,
      });
      generationConfig.maxOutputTokens = registeredPlan.maxOutputTokens;
      if (registeredPlan.thinking.kind === 'disabled') {
        delete generationConfig.thinkingConfig;
      } else if (registeredPlan.thinking.kind === 'adaptive') {
        generationConfig.thinkingConfig = {
          includeThoughts: registeredPlan.includeThoughts,
          thinkingBudget: -1,
        };
      } else if (registeredPlan.thinking.kind === 'budget') {
        generationConfig.thinkingConfig = {
          includeThoughts: registeredPlan.includeThoughts,
          thinkingBudget: registeredPlan.thinking.budget,
        };
      }
      return;
    }

    if (enforceAuthoritativeThinkingBudget) {
      // Authoritative requests still go through the shared planner so a configured
      // -1 or an account-scale budget cannot bypass the output/thinking caps.
      const authoritativeBudget =
        this.resolveConfiguredThinkingBudget(model) ??
        this.getModelThinkingBudget(accountId, model);
      const authoritativePlan = resolveGenerationPlan({
        source: 'gateway',
        model,
        // A 0 capability budget means "thinking disabled for this model", so it must
        // stay on the registered path where 0 is meaningful instead of gateway 0.
        registeredThinkingBudget: authoritativeBudget,
        registeredMaxOutputTokens: generationConfig.maxOutputTokens,
        outputCap: this.getModelOutputCap(accountId, model),
        thinkingCap: this.getModelThinkingBudget(accountId, model),
      });
      generationConfig.maxOutputTokens = authoritativePlan.maxOutputTokens;
      if (authoritativePlan.thinking.kind === 'disabled') {
        delete generationConfig.thinkingConfig;
      } else {
        generationConfig.thinkingConfig = {
          includeThoughts: true,
          thinkingBudget:
            authoritativePlan.thinking.kind === 'budget' ? authoritativePlan.thinking.budget : -1,
        };
      }
    }

    const outputCap = this.getModelOutputCap(accountId, model);
    const thinkingBudgetCap = this.getModelThinkingBudget(accountId, model);
    const normalizedModel = this.normalizeModelIdentifier(model).toLowerCase();
    const isClaudeModel = normalizedModel.includes('claude');
    const isClaudeOpus46Thinking = normalizedModel === 'claude-opus-4-6-thinking';
    const thinkingConfig = generationConfig.thinkingConfig as
      | ({ thinkingLevel?: string; thinkingBudget?: number } & Record<string, unknown>)
      | undefined;
    const adaptiveSentinel =
      thinkingConfig &&
      (isString(thinkingConfig.thinkingLevel) || thinkingConfig.thinkingBudget === -1 || false);

    /**
     * Opus 4.6 rejects otherwise-valid combinations observed with generic thinking
     * defaults. Keep this verified upstream recipe exact across compatible protocols.
     */
    if (isClaudeOpus46Thinking && thinkingConfig) {
      thinkingConfig.includeThoughts = true;
      thinkingConfig.thinkingBudget = Math.min(
        24_576,
        thinkingBudgetCap,
        Math.max(0, outputCap - 1),
      );
      delete thinkingConfig.thinkingLevel;
      generationConfig.maxOutputTokens = Math.min(57_344, outputCap);
      delete generationConfig.stopSequences;
      return;
    }

    if (thinkingConfig) {
      if (!isClaudeModel && isString(thinkingConfig.thinkingLevel)) {
        const converted = this.resolveThinkingLevelBudget(thinkingConfig.thinkingLevel);
        if (converted !== undefined) {
          thinkingConfig.thinkingBudget = converted;
        }
        delete thinkingConfig.thinkingLevel;
      }

      if (isNumber(thinkingConfig.thinkingBudget) && thinkingConfig.thinkingBudget < -1) {
        throw new Error('thinkingBudget must be -1 or a non-negative integer');
      }

      if (thinkingConfig.thinkingBudget === -1) {
        const modelDefault = this.getModelThinkingBudget(accountId, model);
        if (modelDefault >= 0) {
          thinkingConfig.thinkingBudget = Math.min(modelDefault, Math.max(0, outputCap - 1));
        }
      }

      if (
        isNumber(thinkingConfig.thinkingBudget) &&
        Number.isFinite(thinkingConfig.thinkingBudget)
      ) {
        thinkingConfig.thinkingBudget = Math.min(
          Math.floor(thinkingConfig.thinkingBudget),
          Math.max(0, outputCap - 1),
          thinkingBudgetCap,
        );

        if (adaptiveSentinel) {
          if (generationConfig.maxOutputTokens === undefined) {
            generationConfig.maxOutputTokens = outputCap;
          }
        } else if (
          generationConfig.maxOutputTokens === undefined ||
          generationConfig.maxOutputTokens <= thinkingConfig.thinkingBudget
        ) {
          const hasExplicitMax = generationConfig.maxOutputTokens !== undefined;
          const explicitMax = generationConfig.maxOutputTokens;
          if (
            hasExplicitMax &&
            explicitMax !== undefined &&
            thinkingConfig.thinkingBudget >= 6 * explicitMax
          ) {
            thinkingConfig.thinkingBudget = Math.max(0, explicitMax - 1024);
          } else {
            const overhead = hasExplicitMax ? 1024 : 32768;
            const minRequired = Math.min(outputCap, thinkingConfig.thinkingBudget + overhead);
            generationConfig.maxOutputTokens = minRequired;
          }
        }
      }
    }

    if (
      isNumber(generationConfig.maxOutputTokens) &&
      Number.isFinite(generationConfig.maxOutputTokens)
    ) {
      generationConfig.maxOutputTokens = Math.min(
        Math.floor(generationConfig.maxOutputTokens),
        outputCap,
      );
    }
  }

  private resolveConfiguredThinkingBudget(model: string): number | undefined {
    const configured = ConfigManager.getCachedConfig()?.proxy.thinking_budget;
    if (!configured || configured.control_source !== 'gateway') {
      return undefined;
    }
    const normalized = this.normalizeModelIdentifier(model).toLowerCase();
    if (normalized.includes('claude')) {
      if (normalized.includes('low')) return configured.claude_low;
      if (normalized.includes('medium')) return configured.claude_medium;
      if (
        normalized.includes('high') ||
        normalized.includes('opus') ||
        normalized.includes('sonnet')
      )
        return configured.claude_high;
      return configured.claude_budget;
    }
    if (normalized.includes('pro')) {
      return normalized.includes('low') ? configured.pro_low : configured.pro_high;
    }
    if (normalized.includes('flash')) {
      if (normalized.includes('low')) return configured.flash_low;
      if (normalized.includes('medium')) return configured.flash_medium;
      if (normalized.includes('tiered') || normalized.includes('automatic'))
        return configured.flash_tiered;
      return configured.flash_high;
    }
    return undefined;
  }

  private normalizeModelIdentifier(model: string): string {
    return model.replace(/^models\//i, '').trim();
  }

  private resolveThinkingLevelBudget(level: string): number | undefined {
    const normalized = level.trim().toUpperCase();
    if (normalized === 'NONE') {
      return 0;
    }
    if (normalized === 'LOW') {
      return 4096;
    }
    if (normalized === 'MEDIUM') {
      return 8192;
    }
    if (normalized === 'HIGH') {
      return 24576;
    }
    return undefined;
  }

  private getModelOutputCap(accountId: string, model: string): number {
    const normalizedModel = this.normalizeModelIdentifier(model);
    const dynamicCap = this.modelCapabilities.getModelOutputLimitForAccount(
      accountId,
      normalizedModel,
    );
    if (isNumber(dynamicCap) && Number.isFinite(dynamicCap) && dynamicCap > 0) {
      return Math.floor(dynamicCap);
    }
    return getMaxOutputTokens(normalizedModel);
  }

  private getModelThinkingBudget(accountId: string, model: string): number {
    const normalizedModel = this.normalizeModelIdentifier(model);
    const dynamicBudget = this.modelCapabilities.getModelThinkingBudgetForAccount(
      accountId,
      normalizedModel,
    );
    if (isNumber(dynamicBudget) && Number.isFinite(dynamicBudget) && dynamicBudget >= 0) {
      return Math.floor(dynamicBudget);
    }
    return getThinkingBudget(normalizedModel);
  }
}
