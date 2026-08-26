export interface ImportedTokenLifetime {
  expiresIn: number;
  expiryTimestamp: number;
}

export function resolveImportedTokenLifetime(
  nowSeconds: number,
  refreshedExpiresIn?: number,
  verifiedExpiryTimestamp?: number,
  hasRefreshedAccessToken = false,
): ImportedTokenLifetime {
  if (
    typeof refreshedExpiresIn === 'number' &&
    Number.isFinite(refreshedExpiresIn) &&
    refreshedExpiresIn > 0
  ) {
    const expiresIn = Math.floor(refreshedExpiresIn);
    return {
      expiresIn,
      expiryTimestamp: nowSeconds + expiresIn,
    };
  }

  if (hasRefreshedAccessToken) {
    return {
      expiresIn: 0,
      expiryTimestamp: 0,
    };
  }

  if (
    typeof verifiedExpiryTimestamp === 'number' &&
    Number.isFinite(verifiedExpiryTimestamp) &&
    verifiedExpiryTimestamp > 0
  ) {
    const expiryTimestamp = Math.floor(verifiedExpiryTimestamp);
    return {
      expiresIn: Math.max(0, expiryTimestamp - nowSeconds),
      expiryTimestamp,
    };
  }

  return {
    expiresIn: 0,
    expiryTimestamp: 0,
  };
}
