import type { ModelAliasRoute, ProxyConfig } from '@/modules/config/types';

function normalizeRoutePart(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function appendRoute(
  routes: ModelAliasRoute[],
  seenAliases: Set<string>,
  aliasValue: unknown,
  targetValue: unknown,
  enabled: boolean,
  published?: boolean,
): void {
  const alias = normalizeRoutePart(aliasValue);
  const target = normalizeRoutePart(targetValue);

  // Case-sensitive, because routing is: `configuredMapping[normalizedModel]` is an exact object
  // lookup, so `GPT-4o` and `gpt-4o` are two different routes that both work today. Deduplicating
  // case-insensitively here would drop one of them and silently change where a request goes --
  // the one thing a migration must never do.
  if (!alias || !target || seenAliases.has(alias)) {
    return;
  }

  seenAliases.add(alias);
  routes.push({ alias, target, enabled, ...(published === undefined ? {} : { published }) });
}

function legacyEntries(value: unknown): Array<[string, unknown]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value);
}

/**
 * Folds the two legacy mapping objects into the `model_aliases` list and empties them.
 *
 * Idempotent, so it is safe on every load and every save: a config that has already been
 * migrated has empty legacy maps and nothing left to fold.
 *
 * `anthropic_mapping` is folded **before** `custom_mapping` on purpose. Routing today merges
 * them as `{...custom_mapping, ...anthropic_mapping}`, so on a key present in both the
 * Anthropic entry is the one that decides the request. First-entry-wins dedupe therefore has to
 * see it first, or a migration would silently change where an existing alias points -- the one
 * regression a migration must not have.
 */
export function migrateLegacyModelAliases(proxy: ProxyConfig): ProxyConfig {
  const routes: ModelAliasRoute[] = [];
  const seenAliases = new Set<string>();

  if (Array.isArray(proxy.model_aliases)) {
    for (const route of proxy.model_aliases) {
      appendRoute(
        routes,
        seenAliases,
        route?.alias,
        route?.target,
        route?.enabled !== false,
        route?.published,
      );
    }
  }

  for (const [alias, target] of legacyEntries(proxy.anthropic_mapping)) {
    appendRoute(routes, seenAliases, alias, target, true);
  }

  for (const [alias, target] of legacyEntries(proxy.custom_mapping)) {
    appendRoute(routes, seenAliases, alias, target, true);
  }

  return {
    ...proxy,
    model_aliases: routes,
    // The legacy maps are kept as a **derived projection** of the enabled routes rather than
    // emptied, so a user who rolls back to a build that predates `model_aliases` still finds
    // their aliases where that build looks for them. They are regenerated from the list on every
    // save, never merged into it, so deleting a route here deletes it there too. A later release
    // can drop this projection once rolling back that far stops being supported.
    custom_mapping: projectRoutesToLegacyMapping(routes),
    anthropic_mapping: {},
  };
}

function projectRoutesToLegacyMapping(routes: ModelAliasRoute[]): Record<string, string> {
  const mapping: Record<string, string> = {};

  for (const route of routes) {
    if (route.enabled === false) {
      continue;
    }

    mapping[route.alias] = route.target;
  }

  return mapping;
}

/**
 * All enabled aliases for generation, independently of catalog publication.
 *
 * The legacy maps are still read for a config held in memory that never went through
 * {@link migrateLegacyModelAliases} -- notably `setServerConfig` called with a literal in tests
 * and by callers that build a config by hand.
 */
export function getConfiguredModelMapping(
  proxy:
    | Pick<ProxyConfig, 'model_aliases' | 'custom_mapping' | 'anthropic_mapping'>
    | null
    | undefined,
): Record<string, string> {
  if (!proxy) {
    return {};
  }

  const mapping: Record<string, string> = {
    ...(proxy.custom_mapping ?? {}),
    ...(proxy.anthropic_mapping ?? {}),
  };

  for (const route of proxy.model_aliases ?? []) {
    if (!route?.alias || !route.target || route.enabled === false) {
      continue;
    }

    mapping[route.alias] = route.target;
  }

  return mapping;
}

/** Patterns and strategy identifiers are routing controls, never concrete catalog entries. */
export function isModelAliasPublished(
  route: Pick<ModelAliasRoute, 'alias' | 'target' | 'published'>,
): boolean {
  if (route.alias.includes('*') || route.alias.toLowerCase().startsWith('auto:')) {
    return false;
  }
  return route.published ?? !route.target.toLowerCase().startsWith('auto:');
}

/** Publication has its own projection so hiding an alias cannot disable generation. */
export function getPublishedModelMapping(
  proxy:
    | Pick<ProxyConfig, 'model_aliases' | 'custom_mapping' | 'anthropic_mapping'>
    | null
    | undefined,
): Record<string, string> {
  const mapping = getConfiguredModelMapping(proxy);
  for (const [alias, target] of Object.entries(mapping)) {
    if (!isModelAliasPublished({ alias, target })) {
      delete mapping[alias];
    }
  }
  for (const route of proxy?.model_aliases ?? []) {
    // An explicit route owns visibility even when a rollback projection contains its name.
    if (route.enabled === false || !isModelAliasPublished(route)) {
      delete mapping[route.alias];
    } else if (route.alias && route.target) {
      mapping[route.alias] = route.target;
    }
  }
  return mapping;
}

function normalizeClaudeAliasForConflict(alias: string): string {
  return alias
    .trim()
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/^anthropic\//, '')
    .replaceAll('.', '-');
}

/**
 * Rejects aliases that become indistinguishable when routing falls back from an exact lookup.
 * Exact aliases remain case-sensitive, so differently-cased spellings are valid until a request
 * misses them and reaches the case-folded stage. The save boundary only blocks Claude spellings
 * whose punctuation and provider-prefix normalization would change the same canonical route.
 */
export function assertPredictableModelAliasEquivalence(
  proxy: Pick<ProxyConfig, 'model_aliases' | 'custom_mapping' | 'anthropic_mapping'>,
): void {
  const mappings = Object.entries(getConfiguredModelMapping(proxy))
    .filter(([alias, target]) => alias !== '' && target !== '')
    .map(([alias, target]) => ({ alias, target }));
  assertUniqueEquivalentTargets(
    mappings.filter(({ alias }) => alias.toLowerCase().includes('claude-')),
    (alias, requested) =>
      normalizeClaudeAliasForConflict(alias) === normalizeClaudeAliasForConflict(requested),
    'Claude-normalized',
  );
}

function assertUniqueEquivalentTargets(
  mappings: ReadonlyArray<{ alias: string; target: string }>,
  matches: (alias: string, requested: string) => boolean,
  equivalence: string,
): void {
  const groups = new Map<string, Array<{ alias: string; target: string }>>();
  for (const mapping of mappings) {
    const aliases = mappings.filter((candidate) => matches(candidate.alias, mapping.alias));
    const targets = new Set(aliases.map((candidate) => candidate.target));
    if (targets.size <= 1) {
      continue;
    }
    groups.set(
      aliases
        .map((candidate) => candidate.alias)
        .sort()
        .join('\u0000'),
      aliases,
    );
  }
  const conflict = [...groups.values()][0];
  if (!conflict) {
    return;
  }
  throw new Error(
    `Ambiguous ${equivalence} model aliases: ${conflict
      .map(({ alias }) => `"${alias}"`)
      .join(', ')}`,
  );
}
