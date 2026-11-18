import { getServerConfig } from '@/server/server-config';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { isNumber, isString } from 'lodash-es';
import { getMaxOutputTokens, getThinkingBudget } from '../../../../modules/proxy-gateway/antigravity/ModelSpecs';
import type { GeminiInternalRequest, GenerationConfig } from '../../../../modules/proxy-gateway/antigravity/types';
import { resolveGenerationPlan } from '../generation-plan';
import type { ModelThinkingTransport } from '../../common/model-thinking-transport';
import { isDisabledThinkingEffort, parseModelEffort } from '../../common/model-effort';

/**
 * Injection token for the account-side capability reader. A token rather than the concrete
 * `AccountLeaseService` keeps `shared/` free of an import back into `modules/account-lease/`.
 */
export const PROXY_MODEL_CAPABILITY_READER = 'PROXY_MODEL_CAPABILITY_READER';

export interface ProxyModelCapabilityReader {
  getModelOutputLimitForAccount(accountId: string, modelName: string): number | undefined;
  getModelThinkingBudgetForAccount(accountId: string, modelName: string): number | undefined;
  getModelThinkingTransportForAccount?(
    accountId: string,
    modelName: string,
  ): ModelThinkingTransport | undefined;
}

export interface RegisteredGenerationConstraints {
  thinkingBudget: number;
  maxOutputTokens: number;
  includeThoughts: boolean;
  tier?: 'low' | 'medium' | 'high';
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
    const savedBudget = imageGeneration
      ? undefined
      : this.resolveConfiguredThinkingBudget(model, registered?.tier);
    // Legacy zero remains readable in settings. Treat it as an unset override at runtime.
    const configuredBudget = savedBudget === 0 ? undefined : savedBudget;
    const transport = imageGeneration
      ? undefined
      : this.modelCapabilities.getModelThinkingTransportForAccount?.(accountId, model);
    const normalizedModel = this.normalizeModelIdentifier(model).toLowerCase();
    const isOpus46 = normalizedModel === 'claude-opus-4-6-thinking';
    let generationConfig = body.request.generationConfig;
    if (!generationConfig) {
      if (
        !clientControlled &&
        !registered &&
        !enforceAuthoritativeThinkingBudget &&
        configuredBudget === undefined &&
        transport === undefined
      ) {
        return;
      }
      generationConfig = {};
      body.request.generationConfig = generationConfig;
    }

    if (transport?.kind === 'level' || transport?.kind === 'disabled') {
      this.applyDeclaredThinkingTransport(
        generationConfig,
        model,
        accountId,
        transport,
        clientControlled,
        configuredBudget,
        registered,
      );
      return;
    }

    if (clientControlled) {
      const thinkingConfig = generationConfig.thinkingConfig;
      if (
        transport?.kind === 'budget' &&
        thinkingConfig?.thinkingBudget === undefined &&
        thinkingConfig?.thinkingLevel !== undefined &&
        !isDisabledThinkingEffort(thinkingConfig.thinkingLevel)
      ) {
        throw new BadRequestException('This model accepts a numeric thinking budget.');
      }
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

    const outputCap = this.getModelOutputCap(accountId, model);
    const thinkingBudgetCap = this.getModelThinkingBudget(accountId, model);
    const existing = generationConfig.thinkingConfig;
    // Keep the verified Opus envelope for the unregistered route without a fixed override.
    if (
      isOpus46 &&
      !registered &&
      (configuredBudget === undefined || configuredBudget === -1) &&
      (existing || configuredBudget === -1 || transport?.kind === 'budget')
    ) {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: Math.min(24_576, thinkingBudgetCap, Math.max(0, outputCap - 1)),
      };
      generationConfig.maxOutputTokens = Math.min(57_344, outputCap);
      delete generationConfig.stopSequences;
      return;
    }
    if (
      registered ||
      enforceAuthoritativeThinkingBudget ||
      configuredBudget !== undefined ||
      transport?.kind === 'budget'
    ) {
      const capOpusOverride = isOpus46 && configuredBudget !== undefined;
      const plan = resolveGenerationPlan({
        source: 'gateway',
        model,
        imageGeneration,
        gatewayThinkingBudget: configuredBudget,
        registeredThinkingBudget:
          registered?.thinkingBudget ??
          (transport?.kind === 'budget' ? transport.defaultBudget : undefined) ??
          (enforceAuthoritativeThinkingBudget ? thinkingBudgetCap : existing?.thinkingBudget),
        registeredMaxOutputTokens: registered?.maxOutputTokens,
        explicitMaxOutputTokens: generationConfig.maxOutputTokens,
        outputCap: capOpusOverride ? Math.min(57_344, outputCap) : outputCap,
        thinkingCap: capOpusOverride ? Math.min(24_576, thinkingBudgetCap) : thinkingBudgetCap,
        includeThoughts: registered?.includeThoughts ?? existing?.includeThoughts,
      });
      generationConfig.maxOutputTokens = plan.maxOutputTokens;
      if (plan.thinking.kind === 'disabled') {
        delete generationConfig.thinkingConfig;
      } else if (plan.thinking.kind === 'budget' || plan.thinking.kind === 'adaptive') {
        generationConfig.thinkingConfig = {
          includeThoughts: plan.includeThoughts,
          thinkingBudget: plan.thinking.kind === 'adaptive' ? -1 : plan.thinking.budget,
        };
      }
      if (capOpusOverride) {
        delete generationConfig.stopSequences;
      }
      return;
    }
    const thinkingConfig = generationConfig.thinkingConfig;

    if (thinkingConfig) {
      if (!normalizedModel.includes('claude') && isString(thinkingConfig.thinkingLevel)) {
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

  private applyDeclaredThinkingTransport(
    config: GenerationConfig,
    model: string,
    accountId: string,
    transport: Extract<ModelThinkingTransport, { kind: 'level' | 'disabled' }>,
    clientControlled: boolean,
    configuredBudget: number | undefined,
    registered?: RegisteredGenerationConstraints,
  ): void {
    const current = config.thinkingConfig;
    const isOpus46 =
      this.normalizeModelIdentifier(model).toLowerCase() === 'claude-opus-4-6-thinking';
    const disabled =
      clientControlled &&
      (current?.thinkingBudget === 0 || isDisabledThinkingEffort(current?.thinkingLevel));
    if (transport.kind === 'level' && disabled) {
      throw new BadRequestException(
        'This model does not support disabling thinking through its level parameter',
      );
    }
    if (isOpus46 && (transport.kind === 'disabled' || disabled)) {
      throw new BadRequestException('This model does not support disabling thinking');
    }
    const numericBudget = clientControlled ? current?.thinkingBudget : configuredBudget;
    if (transport.kind === 'level' && numericBudget !== undefined && numericBudget !== -1) {
      throw new BadRequestException(
        'This model accepts a thinking level, not a numeric thinking budget',
      );
    }
    const requestedLevel =
      transport.kind === 'level'
        ? clientControlled
          ? current?.thinkingBudget === -1
            ? transport.defaultLevel
            : (current?.thinkingLevel ?? transport.defaultLevel)
          : (registered?.tier ?? current?.thinkingLevel ?? transport.defaultLevel)
        : undefined;
    const parsed = requestedLevel === undefined ? undefined : parseModelEffort(requestedLevel);
    if (requestedLevel !== undefined && !parsed) {
      throw new BadRequestException('Unsupported model thinking level');
    }
    const plan = resolveGenerationPlan({
      source: 'client',
      model,
      clientDisabled: transport.kind === 'disabled',
      clientEffort: parsed === 'extra-low' ? 'low' : (parsed ?? undefined),
      explicitMaxOutputTokens: config.maxOutputTokens,
      registeredMaxOutputTokens: registered?.maxOutputTokens,
      outputCap: Math.min(this.getModelOutputCap(accountId, model), isOpus46 ? 57_344 : Infinity),
      thinkingCap: this.getModelThinkingBudget(accountId, model),
      includeThoughts: current?.includeThoughts ?? registered?.includeThoughts,
    });
    config.maxOutputTokens = plan.maxOutputTokens;
    if (plan.thinking.kind === 'level') {
      config.thinkingConfig = {
        includeThoughts: plan.includeThoughts,
        thinkingLevel: plan.thinking.level.toUpperCase(),
      };
    } else if (plan.thinking.kind === 'disabled') {
      delete config.thinkingConfig;
    }
    if (isOpus46) {
      delete config.stopSequences;
    }
  }

  private resolveConfiguredThinkingBudget(
    model: string,
    tier?: 'low' | 'medium' | 'high',
  ): number | undefined {
    const configured =
      getServerConfig()?.thinking_budget ?? ConfigManager.getCachedConfig()?.proxy.thinking_budget;
    if (!configured || configured.control_source !== 'gateway') {
      return undefined;
    }
    const normalized = this.normalizeModelIdentifier(model).toLowerCase();
    if (normalized.startsWith('claude-')) {
      const selectedTier = /-(low|medium|high)$/.exec(normalized)?.[1] ?? tier;
      if (selectedTier === 'low') {
        return configured.claude_low;
      }
      if (selectedTier === 'medium') {
        return configured.claude_medium;
      }
      if (selectedTier === 'high') {
        return configured.claude_high;
      }
      return configured.claude_budget;
    }
    if (!/^gemini-(?:[3-9]|\d{2,})(?:[.-]|$)/.test(normalized)) {
      return undefined;
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
