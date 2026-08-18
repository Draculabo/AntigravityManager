import { getServerConfig } from '../../../../../server/server-config';
import { normalizeGeminiModelAlias, resolveModelRoute } from '../../../antigravity/ModelMapping';

export class ModelRoutingService {
  normalizeGeminiModel(model: string): string {
    return model.replace(/^models\//i, '');
  }

  resolveTargetModel(model: string): string {
    const normalizedModel = model.replace(/^models\//i, '').trim();
    const config = getServerConfig();
    const customMapping = config?.custom_mapping ?? {};
    const anthropicMapping = config?.anthropic_mapping ?? {};

    const customExactMapping: Record<string, string> = {};
    const wildcardMapping: Array<{
      pattern: RegExp;
      target: string;
    }> = [];

    for (const [key, target] of Object.entries(customMapping)) {
      if (!key || !target) {
        continue;
      }

      if (key.includes('*')) {
        const escaped = key.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        wildcardMapping.push({
          pattern: new RegExp(`^${escaped}$`, 'i'),
          target,
        });
        continue;
      }

      customExactMapping[key] = target;
    }

    for (const wildcardRule of wildcardMapping) {
      if (wildcardRule.pattern.test(normalizedModel)) {
        return wildcardRule.target;
      }
    }

    const routedModel = resolveModelRoute(normalizedModel, customExactMapping, {}, anthropicMapping);
    return normalizeGeminiModelAlias(routedModel);
  }

  createModelSpecificHeaders(model: string | undefined): Record<string, string> {
    if (!model) {
      return {};
    }

    if (model.toLowerCase().includes('claude')) {
      return {
        'anthropic-beta':
          'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
      };
    }

    return {};
  }
}
