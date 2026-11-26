export type LocaleCatalog = {
  readonly [key: string]: string | LocaleCatalog;
};

function isLocaleCatalog(value: string | LocaleCatalog): value is LocaleCatalog {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeLocaleCatalog(base: LocaleCatalog, overrides: LocaleCatalog): LocaleCatalog {
  const merged: { [key: string]: string | LocaleCatalog } = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const baseValue = merged[key];
    merged[key] =
      isLocaleCatalog(baseValue) && isLocaleCatalog(value)
        ? mergeLocaleCatalog(baseValue, value)
        : value;
  }
  return merged;
}
