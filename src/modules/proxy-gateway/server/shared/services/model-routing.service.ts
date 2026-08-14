import { Inject, Injectable, Optional } from '@nestjs/common';
import { getServerConfig } from '../../../../../server/server-config';
import {
  getDynamicForwardingTarget,
  lookupBuiltInModelMapping,
  lookupGeminiModelAlias,
  normalizeGeminiModelAlias,
} from '../../../antigravity/ModelMapping';
import { getConfiguredModelMapping } from '@/modules/config/model-aliases';
import { ModelRouteMissJournalService } from './model-route-miss-journal.service';

/**
 * How a route was decided.
 *
 * `canonical` and `built-in` are both "a rule fired and it lives in the source" -- the
 * difference is only whether the rule's target equals its own key (a supported model
 * round-tripping to itself) or actually renames the id. `miss` is the only case where no rule
 * fired anywhere and the client's string was forwarded unchanged; that is the one case the
 * route-miss journal records.
 */
export type ModelRouteSource = 'canonical' | 'built-in' | 'configured' | 'dynamic-legacy' | 'miss';

export interface ModelRouteResolution {
  /** The model id exactly as the client sent it (before prefix stripping). */
  requestedModel: string;
  /** `requestedModel` with a leading `models/` stripped and whitespace trimmed. */
  normalizedModel: string;
  /** The id this gateway will send upstream. */
  resolvedModel: string;
  source: ModelRouteSource;
}

function normalizeModelId(model: string): string {
  return model.replace(/^models\//i, '').trim();
}

function resolveAnthropicFamilyMapping(
  model: string,
  configuredMapping: Record<string, string>,
): string | undefined {
  const normalizedModel = model.toLowerCase();
  if (!normalizedModel.startsWith('claude-')) {
    return undefined;
  }

  const familyKey =
    normalizedModel.includes('4-5') || normalizedModel.includes('4.5')
      ? 'claude-4.5-series'
      : normalizedModel.includes('3-5') || normalizedModel.includes('3.5')
        ? 'claude-3.5-series'
        : 'claude-default';
  return configuredMapping[familyKey];
}

@Injectable()
export class ModelRoutingService {
  public constructor(
    @Optional()
    @Inject(ModelRouteMissJournalService)
    private readonly missJournal?: ModelRouteMissJournalService,
  ) {}

  normalizeGeminiModel(model: string): string {
    return normalizeModelId(model);
  }

  /**
   * Decides where `model` routes and why, without side effects. Safe to call any number of
   * times for the same request -- unlike {@link resolveModelRouteForRequest}, it never touches
   * the route-miss journal, so callers that only need the target id (or need to re-derive it
   * downstream, as `countTokensWithLease` does) can call this freely.
   */
  resolveModelRoute(model: string): ModelRouteResolution {
    const normalizedModel = normalizeModelId(model);
    const config = getServerConfig();
    const configuredMapping = getConfiguredModelMapping(config);

    const customExactMapping: Record<string, string> = {};
    const wildcardMapping: Array<{ pattern: RegExp; target: string }> = [];

    for (const [key, target] of Object.entries(configuredMapping)) {
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
        return {
          requestedModel: model,
          normalizedModel,
          resolvedModel: wildcardRule.target,
          source: 'configured',
        };
      }
    }

    const dynamicForwarded = getDynamicForwardingTarget(normalizedModel);
    if (dynamicForwarded) {
      return {
        requestedModel: model,
        normalizedModel,
        resolvedModel: normalizeGeminiModelAlias(dynamicForwarded),
        source: 'dynamic-legacy',
      };
    }

    if (customExactMapping[normalizedModel]) {
      return {
        requestedModel: model,
        normalizedModel,
        resolvedModel: normalizeGeminiModelAlias(customExactMapping[normalizedModel]),
        source: 'configured',
      };
    }

    const anthropicFamilyTarget = resolveAnthropicFamilyMapping(normalizedModel, configuredMapping);
    if (anthropicFamilyTarget) {
      return {
        requestedModel: model,
        normalizedModel,
        resolvedModel: normalizeGeminiModelAlias(anthropicFamilyTarget),
        source: 'configured',
      };
    }

    const builtIn = lookupBuiltInModelMapping(normalizedModel);
    if (builtIn !== undefined) {
      const resolvedModel = normalizeGeminiModelAlias(builtIn);
      return {
        requestedModel: model,
        normalizedModel,
        resolvedModel,
        source: resolvedModel === normalizedModel ? 'canonical' : 'built-in',
      };
    }

    const aliasedFallback = lookupGeminiModelAlias(normalizedModel);
    if (aliasedFallback !== undefined) {
      return {
        requestedModel: model,
        normalizedModel,
        resolvedModel: aliasedFallback,
        source: 'built-in',
      };
    }

    return {
      requestedModel: model,
      normalizedModel,
      resolvedModel: normalizedModel,
      source: 'miss',
    };
  }

  /**
   * The single per-request entry point: resolves the route and, if nothing matched, records the
   * miss. Call this exactly once per incoming request -- protocol handlers that need the target
   * model again downstream (as `countTokensWithLease` does) should read {@link resolveTargetModel}
   * instead, so a request the journal already counted is never counted twice.
   */
  resolveModelRouteForRequest(model: string): ModelRouteResolution {
    const resolution = this.resolveModelRoute(model);
    if (resolution.source === 'miss') {
      this.missJournal?.record(resolution.requestedModel);
    }
    return resolution;
  }

  resolveTargetModel(model: string): string {
    return this.resolveModelRoute(model).resolvedModel;
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
