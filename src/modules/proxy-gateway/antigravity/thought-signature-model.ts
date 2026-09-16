import { resolveModelVariant } from './model-variant-registry';

export interface ThoughtSignatureModelContext {
  model: string;
  /** Canonical family resolved for {@link familyModel}; ignored when that model is not current. */
  family?: string | null;
  /** Physical model from which `family` was resolved. */
  familyModel?: string | null;
}

export interface NormalizedThoughtSignatureModelContext {
  model: string;
  family: string | null;
}

function normalizeModelName(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeThoughtSignatureModelContext(
  context: ThoughtSignatureModelContext,
): NormalizedThoughtSignatureModelContext | null {
  const model = normalizeModelName(context.model);
  if (!model) {
    return null;
  }

  const explicitFamilyModel = context.familyModel ? normalizeModelName(context.familyModel) : null;
  const explicitFamily =
    context.family && explicitFamilyModel === model ? normalizeModelName(context.family) : null;
  const directFamily = resolveModelVariant({ model })?.canonicalModel ?? null;
  const compatibilityAlias = model.endsWith('-thinking')
    ? model.slice(0, -'-thinking'.length)
    : null;
  const resolvedFamily =
    directFamily ??
    (compatibilityAlias
      ? (resolveModelVariant({ model: compatibilityAlias })?.canonicalModel ?? null)
      : null);
  return {
    model,
    family: explicitFamily || resolvedFamily,
  };
}

export function areThoughtSignatureModelsCompatible(
  source: NormalizedThoughtSignatureModelContext,
  target: NormalizedThoughtSignatureModelContext,
): boolean {
  if (source.family && target.family) {
    return source.family === target.family;
  }

  return source.model === target.model;
}
