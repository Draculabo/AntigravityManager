import { getServerConfig } from '@/server/server-config';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
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
    const clientControlled =
      (getServerConfig()?.thinking_budget ?? ConfigManager.getCachedConfig()?.proxy.thinking_budget)
        ?.control_source === 'client';
    const imageGeneration =
      body.requestType === 'image_gen' ||
      body.request.generationConfig?.responseModalities?.some(
        (modality) => modality.toLowerCase() === 'image',
      ) === true ||
      model.toLowerCase().includes('-image');
    let generationConfig = body.request.generationConfig;
    if (!generationConfig) {
      if (!clientControlled && !registered && !enforceAuthoritativeThinkingBudget) {
        return;
      }
      generationConfig = {};
      body.request.generationConfig = generationConfig;
    }

    if (clientControlled) {
      const thinkingConfig = generationConfig.thinkingConfig;
      const isOpus46 =
        this.normalizeModelIdentifier(model).toLowerCase() === 'claude-opus-4-6-thinking';
      const clientPlan = resolveGenerationPlan({
        source: 'client',
        model,
        imageGeneration,
        clientDisabled: this.getModelThinkingBudget(accountId, model) === 0,
        clientBudget: thinkingConfig?.thinkingBudget,
        clientEffort: thinkingConfig?.thinkingLevel,
        explicitMaxOutputTokens: generationConfig.maxOutputTokens,
        outputCap: Math.min(this.getModelOutputCap(accountId, model), isOpus46 ? 57_344 : Infinity),
        thinkingCap: Math.min(
          this.getModelThinkingBudget(accountId, model),
          isOpus46 ? 24_576 : Infinity,
        ),
        includeThoughts: thinkingConfig?.includeThoughts,
      });
      if (isOpus46 && clientPlan.thinking.kind === 'disabled') {
        throw new BadRequestException('This model does not support disabling thinking');
      }
      generationConfig.maxOutputTokens = clientPlan.maxOutputTokens;
      switch (clientPlan.thinking.kind) {
        case 'disabled':
          generationConfig.thinkingConfig = { includeThoughts: false, thinkingBudget: 0 };
          break;
        case 'adaptive':
          generationConfig.thinkingConfig = {
            includeThoughts: clientPlan.includeThoughts,
            thinkingBudget: -1,
          };
          break;
        case 'budget':
          generationConfig.thinkingConfig = {
            includeThoughts: clientPlan.includeThoughts,
            thinkingBudget: clientPlan.thinking.budget,
          };
          break;
        case 'level':
          generationConfig.thinkingConfig = {
            includeThoughts: clientPlan.includeThoughts,
            thinkingLevel: clientPlan.thinking.level,
          };
          break;
      }
      if (isOpus46) {
        delete generationConfig.stopSequences;
      }
      return;
    }

    if (registered) {
      const registeredPlan = resolveGenerationPlan({
        source: 'gateway',
        model,
        imageGeneration,
        registeredThinkingBudget:
          this.resolveConfiguredThinkingBudget(model) ?? registered.thinkingBudget,
        registeredMaxOutputTokens: registered.maxOutputTokens,
        explicitMaxOutputTokens: generationConfig.maxOutputTokens,
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
        imageGeneration,
        // A 0 capability budget means "thinking disabled for this model", so it must
        // stay on the registered path where 0 is meaningful instead of gateway 0.
        registeredThinkingBudget: authoritativeBudget,
        explicitMaxOutputTokens: generationConfig.maxOutputTokens,
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

      const plan = resolveGenerationPlan({
        source: 'gateway',
        model,
        imageGeneration,
        registeredThinkingBudget: thinkingConfig.thinkingBudget,
        clientEffort: thinkingConfig.thinkingLevel,
        explicitMaxOutputTokens: generationConfig.maxOutputTokens,
        outputCap,
        thinkingCap: thinkingBudgetCap,
        includeThoughts: generationConfig.thinkingConfig?.includeThoughts,
      });
      generationConfig.maxOutputTokens = plan.maxOutputTokens;
      if (plan.thinking.kind === 'budget') {
        thinkingConfig.thinkingBudget = plan.thinking.budget;
      } else if (plan.thinking.kind === 'adaptive') {
        thinkingConfig.thinkingBudget = -1;
      } else if (plan.thinking.kind === 'disabled') {
        thinkingConfig.thinkingBudget = 0;
        thinkingConfig.includeThoughts = false;
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
    const configured =
      getServerConfig()?.thinking_budget ?? ConfigManager.getCachedConfig()?.proxy.thinking_budget;
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
      if (normalized.includes('low')) {
        return configured.flash_low > 0 ? configured.flash_low : 1_000;
      }
      if (normalized.includes('medium')) {
        return configured.flash_medium > 0 ? configured.flash_medium : 4_000;
      }
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
