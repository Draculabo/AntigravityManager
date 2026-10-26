import { Inject, Injectable, Optional } from '@nestjs/common';
import { getServerConfig } from '../../../../../server/server-config';
import {
  getAnthropicFamilyMappingKey,
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

export type ModelRouteMatch =
  | 'dynamic-forwarding'
  | 'exact'
  | 'case-folded-exact'
  | 'claude-normalized-exact'
  | 'wildcard'
  | 'anthropic-family'
  | 'built-in'
  | 'passthrough';

export interface ModelRouteRule {
  alias: string;
  target: string;
}

export interface ModelRouteResolution {
  /** The model id exactly as the client sent it (before prefix stripping). */
  requestedModel: string;
  /** `requestedModel` with a leading `models/` stripped and whitespace trimmed. */
  normalizedModel: string;
  /** The id this gateway will send upstream. */
  resolvedModel: string;
  source: ModelRouteSource;
  /** The concrete rule that selected the target. */
  match: ModelRouteMatch;
  /** The user-configured rule responsible for a configured match. */
  matchedRule?: ModelRouteRule;
}

function normalizeModelId(model: string): string {
  return model.trim().replace(/^models\//i, '');
}

function normalizeClaudeModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/^anthropic\//, '')
    .replaceAll('.', '-');
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

    const customExactMapping: Array<{ alias: string; target: string }> = [];
    const wildcardMapping: Array<{
      pattern: RegExp;
      target: string;
      specificity: number;
      configuredIndex: number;
      alias: string;
    }> = [];

    for (const [configuredIndex, [key, target]] of Object.entries(configuredMapping).entries()) {
      if (!key || !target) {
        continue;
      }

      if (key.includes('*')) {
        const escaped = key.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        wildcardMapping.push({
          pattern: new RegExp(`^${escaped}$`, 'i'),
          target,
          specificity: key.replaceAll('*', '').length,
          configuredIndex,
          alias: key,
        });
        continue;
      }

      customExactMapping.push({ alias: key, target });
    }

    const dynamicForwarded = getDynamicForwardingTarget(normalizedModel);
    if (dynamicForwarded) {
      return {
        requestedModel: model,
        normalizedModel,
        resolvedModel: normalizeGeminiModelAlias(dynamicForwarded),
        source: 'dynamic-legacy',
        match: 'dynamic-forwarding',
      };
    }

    const exact = customExactMapping.find((entry) => entry.alias.trim() === normalizedModel.trim());
    if (exact) {
      return {
        requestedModel: model,
        normalizedModel,
        resolvedModel: normalizeGeminiModelAlias(exact.target),
        source: 'configured',
        match: 'exact',
        matchedRule: exact,
      };
    }

    const caseFolded = this.resolveUniqueEquivalentMapping(
      customExactMapping,
      normalizedModel,
      (alias, requested) => alias.trim().toLowerCase() === requested.trim().toLowerCase(),
      'case-insensitive',
    );
    if (caseFolded) {
      return {
        requestedModel: model,
        normalizedModel,
        resolvedModel: normalizeGeminiModelAlias(caseFolded.target),
        source: 'configured',
        match: 'case-folded-exact',
        matchedRule: caseFolded,
      };
    }

    const claudeNormalized = normalizedModel.toLowerCase().startsWith('claude-')
      ? this.resolveUniqueEquivalentMapping(
          customExactMapping,
          normalizedModel,
          (alias, requested) => normalizeClaudeModelId(alias) === normalizeClaudeModelId(requested),
          'Claude-normalized',
        )
      : undefined;
    if (claudeNormalized) {
      return {
        requestedModel: model,
        normalizedModel,
        resolvedModel: normalizeGeminiModelAlias(claudeNormalized.target),
        source: 'configured',
        match: 'claude-normalized-exact',
        matchedRule: claudeNormalized,
      };
    }

    wildcardMapping.sort(
      (left, right) =>
        right.specificity - left.specificity || left.configuredIndex - right.configuredIndex,
    );
    for (const wildcardRule of wildcardMapping) {
      if (wildcardRule.pattern.test(normalizedModel)) {
        return {
          requestedModel: model,
          normalizedModel,
          resolvedModel: normalizeGeminiModelAlias(wildcardRule.target),
          source: 'configured',
          match: 'wildcard',
          matchedRule: { alias: wildcardRule.alias, target: wildcardRule.target },
        };
      }
    }

    const anthropicFamilyKey = getAnthropicFamilyMappingKey(normalizedModel);
    const anthropicFamilyTarget = anthropicFamilyKey
      ? configuredMapping[anthropicFamilyKey]
      : undefined;
    if (anthropicFamilyKey && anthropicFamilyTarget) {
      return {
        requestedModel: model,
        normalizedModel,
        resolvedModel: normalizeGeminiModelAlias(anthropicFamilyTarget),
        source: 'configured',
        match: 'anthropic-family',
        matchedRule: { alias: anthropicFamilyKey, target: anthropicFamilyTarget },
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
        match: 'built-in',
      };
    }

    const aliasedFallback = lookupGeminiModelAlias(normalizedModel);
    if (aliasedFallback !== undefined) {
      return {
        requestedModel: model,
        normalizedModel,
        resolvedModel: aliasedFallback,
        source: 'built-in',
        match: 'built-in',
      };
    }

    return {
      requestedModel: model,
      normalizedModel,
      resolvedModel: normalizedModel,
      source: 'miss',
      match: 'passthrough',
    };
  }

  private resolveUniqueEquivalentMapping(
    mappings: ReadonlyArray<{ alias: string; target: string }>,
    requestedModel: string,
    matches: (alias: string, requestedModel: string) => boolean,
    equivalence: string,
  ): { alias: string; target: string } | undefined {
    const candidates = mappings.filter((entry) => matches(entry.alias, requestedModel));
    const targets = new Set(candidates.map((entry) => entry.target));
    if (targets.size > 1) {
      throw new Error(
        `Ambiguous ${equivalence} model aliases for "${requestedModel}": ${candidates
          .map((entry) => `"${entry.alias}"`)
          .join(', ')}`,
      );
    }
    return candidates[0];
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
