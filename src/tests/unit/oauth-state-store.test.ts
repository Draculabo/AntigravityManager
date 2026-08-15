import { beforeEach, describe, expect, it } from 'vitest';
import { OAuthStateStore } from '@/modules/cloud-account/services/OAuthStateStore';

describe('OAuthStateStore', () => {
  beforeEach(() => {
    OAuthStateStore.clear();
  });

  it('accepts the expected state exactly once', () => {
    OAuthStateStore.begin('expected-state', 1_000);

    expect(OAuthStateStore.consume('expected-state', 2_000)).toBe(true);
    expect(OAuthStateStore.consume('expected-state', 2_001)).toBe(false);
  });

  it('rejects missing and wrong states without consuming the pending transaction', () => {
    OAuthStateStore.begin('expected-state', 1_000);

    expect(OAuthStateStore.consume(null, 2_000)).toBe(false);
    expect(OAuthStateStore.consume('wrong-state', 2_001)).toBe(false);
    expect(OAuthStateStore.consume('expected-state', 2_002)).toBe(true);
  });

  it('rejects expired state and clears the transaction', () => {
    OAuthStateStore.begin('expected-state', 1_000);

    expect(OAuthStateStore.consume('expected-state', 601_000)).toBe(false);
    expect(OAuthStateStore.consume('expected-state', 601_001)).toBe(false);
  });

  it('invalidates the previous transaction when a new flow starts', () => {
    OAuthStateStore.begin('first-state', 1_000);
    OAuthStateStore.begin('second-state', 2_000);

    expect(OAuthStateStore.consume('first-state', 3_000)).toBe(false);
    expect(OAuthStateStore.consume('second-state', 3_001)).toBe(true);
  });
});
