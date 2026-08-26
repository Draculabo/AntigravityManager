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

  it('uses the verified IDE expiry when the token was not refreshed', () => {
    expect(resolveImportedTokenLifetime(1_700_000_000, undefined, 1_700_001_800)).toEqual({
      expiresIn: 1800,
      expiryTimestamp: 1_700_001_800,
    });
  });

  it('keeps the verified IDE expiry when it is already expired', () => {
    expect(resolveImportedTokenLifetime(1_700_000_000, undefined, 1_699_999_999)).toEqual({
      expiresIn: 0,
      expiryTimestamp: 1_699_999_999,
    });
  });

  it('prefers a freshly returned lifetime over the prior IDE expiry', () => {
    expect(resolveImportedTokenLifetime(1_700_000_000, 3600, 1_700_001_800)).toEqual({
      expiresIn: 3600,
      expiryTimestamp: 1_700_003_600,
    });
  });

  it('does not apply the prior IDE expiry to a refreshed token without a valid lifetime', () => {
    expect(resolveImportedTokenLifetime(1_700_000_000, undefined, 1_700_001_800, true)).toEqual({
      expiresIn: 0,
      expiryTimestamp: 0,
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
