export interface ImportedTokenLifetime {
  expiresIn: number;
  expiryTimestamp: number;
}

export function resolveImportedTokenLifetime(
  nowSeconds: number,
  refreshedExpiresIn?: number,
): ImportedTokenLifetime {
  if (
    typeof refreshedExpiresIn !== 'number' ||
    !Number.isFinite(refreshedExpiresIn) ||
    refreshedExpiresIn <= 0
  ) {
    return {
      expiresIn: 0,
      expiryTimestamp: 0,
    };
  }

  const expiresIn = Math.floor(refreshedExpiresIn);
  return {
    expiresIn,
    expiryTimestamp: nowSeconds + expiresIn,
  };
}
