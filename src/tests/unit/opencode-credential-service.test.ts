import { describe, expect, it, vi } from 'vitest';
import {
  OpenCodeCredentialService,
  type OpenCodeCredentialStore,
} from '@/modules/proxy-gateway/opencode-sync/opencode-credential.service';

function createStore(initialValue: string | null = null): OpenCodeCredentialStore {
  let value = initialValue;
  return {
    delete: vi.fn(() => {
      value = null;
    }),
    read: vi.fn(() => value),
    write: vi.fn((nextValue) => {
      value = nextValue;
    }),
  };
}

describe('OpenCodeCredentialService', () => {
  it('creates a dedicated key once and reuses it', () => {
    const store = createStore();
    const service = new OpenCodeCredentialService(store, () => Buffer.alloc(32, 7));

    const first = service.getOrCreate();
    const second = service.getOrCreate();

    expect(first).toMatch(/^agm_oc_[A-Za-z0-9_-]+$/);
    expect(second).toBe(first);
    expect(store.write).toHaveBeenCalledTimes(1);
  });

  it('rotates and revokes without exposing the previous key', () => {
    const store = createStore('agm_oc_previous');
    const randomBytes = vi
      .fn<() => Buffer>()
      .mockReturnValueOnce(Buffer.alloc(32, 1))
      .mockReturnValueOnce(Buffer.alloc(32, 2));
    const service = new OpenCodeCredentialService(store, randomBytes);

    const rotated = service.rotate();

    expect(rotated).not.toBe('agm_oc_previous');
    expect(service.matches('agm_oc_previous')).toBe(false);
    expect(service.matches(rotated)).toBe(true);

    service.revoke();

    expect(service.matches(rotated)).toBe(false);
    expect(store.delete).toHaveBeenCalledOnce();
  });

  it('uses a timing-safe comparison only for equal-length keys', () => {
    const store = createStore('agm_oc_expected');
    const service = new OpenCodeCredentialService(store);

    expect(service.matches('short')).toBe(false);
    expect(service.matches('agm_oc_expected')).toBe(true);
  });
});
