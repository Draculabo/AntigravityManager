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
): void {
  const alias = normalizeRoutePart(aliasValue);
  const target = normalizeRoutePart(targetValue);
  const key = alias.toLowerCase();

  if (!alias || !target || seenAliases.has(key)) {
    return;
  }

  seenAliases.add(key);
  routes.push({ alias, target, enabled });
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
      appendRoute(routes, seenAliases, route?.alias, route?.target, route?.enabled !== false);
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
    custom_mapping: {},
    anthropic_mapping: {},
  };
}

/**
 * The user's aliases in the exact-map shape the routing engine and both model catalogs already
 * consume, so adding the alias list did not have to change their signatures.
 *
 * Disabled routes are dropped here rather than at every call site: a retired alias must not
 * route a request and must not appear in a published catalog, and one projection is what keeps
 * those two answers from drifting apart.
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
