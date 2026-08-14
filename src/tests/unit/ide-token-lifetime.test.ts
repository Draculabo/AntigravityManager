import { describe, expect, it } from 'vitest';
import { resolveImportedTokenLifetime } from '@/modules/cloud-account/persistence/ide-token-lifetime';

describe('resolveImportedTokenLifetime', () => {
  it('marks imported tokens without verified expiry as immediately refreshable', () => {
    expect(resolveImportedTokenLifetime(1_700_000_000)).toEqual({
      expiresIn: 0,
      expiryTimestamp: 0,
    });
  });

  it('uses the real lifetime returned by a successful token refresh', () => {
    expect(resolveImportedTokenLifetime(1_700_000_000, 1800)).toEqual({
      expiresIn: 1800,
      expiryTimestamp: 1_700_001_800,
    });
  });

  it('rejects invalid refreshed lifetimes instead of inventing a one hour expiry', () => {
    expect(resolveImportedTokenLifetime(1_700_000_000, Number.NaN)).toEqual({
      expiresIn: 0,
      expiryTimestamp: 0,
    });
    expect(resolveImportedTokenLifetime(1_700_000_000, -1)).toEqual({
      expiresIn: 0,
      expiryTimestamp: 0,
    });
  });
});
