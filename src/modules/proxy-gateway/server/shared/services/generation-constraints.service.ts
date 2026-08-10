import { isNumber, isString } from 'lodash-es';
import { getMaxOutputTokens, getThinkingBudget } from '../../../antigravity/ModelSpecs';
import type { GeminiInternalRequest } from '../../../antigravity/types';

export interface ProxyModelCapabilityReader {
  getModelOutputLimitForAccount(accountId: string, modelName: string): number | undefined;
  getModelThinkingBudgetForAccount(accountId: string, modelName: string): number | undefined;
}

export interface RegisteredGenerationConstraints {
  thinkingBudget: number;
  maxOutputTokens: number;
  includeThoughts: boolean;
}

export class GenerationConstraintsService {
  constructor(private readonly modelCapabilities: ProxyModelCapabilityReader) {}

  applyInternalGenerationConstraints(
    body: GeminiInternalRequest,
    model: string,
    accountId: string,
    registered?: RegisteredGenerationConstraints,
  ): void {
    const generationConfig = body.request.generationConfig;
    if (!generationConfig) {
      return;
    }

    if (registered) {
      generationConfig.maxOutputTokens = registered.maxOutputTokens;
      if (registered.thinkingBudget === 0) {
        delete generationConfig.thinkingConfig;
      } else {
        generationConfig.thinkingConfig = {
          includeThoughts: registered.includeThoughts,
          thinkingBudget: registered.thinkingBudget,
        };
      }
      return;
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
      (isString(thinkingConfig.thinkingLevel) ||
        thinkingConfig.thinkingBudget === -1 ||
        thinkingConfig.thinkingBudget === 32768);

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

      if (isNumber(thinkingConfig.thinkingBudget) && thinkingConfig.thinkingBudget < 0) {
        thinkingConfig.thinkingBudget = Math.min(thinkingBudgetCap, 24576);
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
          if (
            generationConfig.maxOutputTokens === undefined ||
            generationConfig.maxOutputTokens < 131072
          ) {
            generationConfig.maxOutputTokens = 131072;
          }
        } else if (
          generationConfig.maxOutputTokens === undefined ||
          generationConfig.maxOutputTokens <= thinkingConfig.thinkingBudget
        ) {
          const hasExplicitMax = generationConfig.maxOutputTokens !== undefined;
          const overhead = hasExplicitMax ? 8192 : 32768;
          const minRequired = Math.min(outputCap, thinkingConfig.thinkingBudget + overhead);
          generationConfig.maxOutputTokens = minRequired;
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
