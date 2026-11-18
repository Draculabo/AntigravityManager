import { resolveModelVariant } from '../../../../modules/proxy-gateway/antigravity/model-variant-registry';
import { parseTieredModel } from '../../modules/account-lease/policies/account-bare-model-tier';
import { parseModelEffort } from '../../common/model-effort';

export interface AdaptiveRoutingContext {
  /** A read-only snapshot of positively advertised, currently eligible physical IDs. */
  getAvailableModels(): ReadonlySet<string>;
  effort?: string;
}

export class NoAvailableAdaptiveModelError extends Error {
  constructor() {
    super('No available accounts (all exhausted or rate limited)');
    this.name = 'NoAvailableAdaptiveModelError';
  }
}

/** An auto target is configuration syntax, never an upstream model or a recursive alias. */
export function resolveAdaptiveModel(
  target: string,
  requestedModel: string,
  context?: AdaptiveRoutingContext,
): string {
  const candidates = [...(context?.getAvailableModels() ?? [])].sort((left, right) =>
    right.localeCompare(left, 'en', { numeric: true }),
  );
  const requestedTier =
    resolveModelVariant({ model: requestedModel, effort: context?.effort })?.tier ??
    parseTieredModel(requestedModel)?.tier ??
    parseModelEffort(context?.effort);
  if (target === 'auto:gemini-flash-low') {
    const tier = requestedTier ?? 'low';
    const selected = candidates.find((model) => {
      if (!/^gemini-.*flash/.test(model) || model.includes('image')) {
        return false;
      }
      const variant = resolveModelVariant({ model, physicalTarget: true });
      return (variant?.tier ?? parseTieredModel(model)?.tier) === tier;
    });
    if (selected) {
      return selected;
    }
  } else if (target === 'auto:claude-opus' || target === 'auto:claude-opus-4-7') {
    const versions = target === 'auto:claude-opus' ? ['5-5', '4-6'] : ['4-7', '4-6', '5-5'];
    for (const version of versions) {
      const selected = candidates.find((model) => {
        const normalized = model.replaceAll('.', '-');
        if (
          !new RegExp(
            `^claude-opus-${version}(?:-(?:thinking|extra-low|low|medium|high|tiered))?$`,
          ).test(normalized)
        ) {
          return false;
        }
        const tier = parseTieredModel(normalized)?.tier;
        return !tier || !requestedTier || tier === requestedTier;
      });
      if (selected) {
        return selected;
      }
    }
  }
  throw new NoAvailableAdaptiveModelError();
}
