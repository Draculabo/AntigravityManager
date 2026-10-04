import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getActiveOAuthClient,
  listOAuthClients,
  setActiveOAuthClient,
} from '@/modules/cloud-account/services/cloud-account-oauth-settings.service';
import { OAuthClientDescriptorSchema } from '@/modules/cloud-account/services/oauth-client-preference.schema';
import { logger } from '@/shared/logging/logger';

const state = vi.hoisted(() => ({ active: 'builtin', stored: '' }));

vi.mock('@/modules/cloud-account/services/GoogleAPIService', () => ({
  GoogleAPIService: {
    listOAuthClients: () =>
      ['builtin', 'custom'].map((key) => ({
        key,
        label: key,
        client_id: `${key}-public-id`,
        client_secret: 'private-client-secret',
        is_active: key === state.active,
        is_builtin: key === 'builtin',
      })),
    getActiveOAuthClientKey: () => state.active,
    setActiveOAuthClientKey: (key: string) => {
      const normalized = key.trim().toLowerCase();
      if (!['builtin', 'custom'].includes(normalized)) {
        throw new Error(`Unknown client ${key}`);
      }
      state.active = normalized;
    },
  },
}));
vi.mock('@/modules/cloud-account/persistence/cloud-account-settings-store', () => ({
  CloudAccountSettingsStore: {
    getSetting: (_key: string, fallback: string) => state.stored || fallback,
    setSetting: (_key: string, value: string) => {
      state.stored = value;
    },
  },
}));
vi.mock('@/shared/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  state.active = 'builtin';
  state.stored = '';
  vi.clearAllMocks();
});

describe('OAuth client preference', () => {
  it('hydrates the persisted selection and projects only public descriptor fields', () => {
    state.stored = 'custom';
    const clients = listOAuthClients();

    expect(getActiveOAuthClient()).toBe('custom');
    expect(clients).toEqual([
      {
        key: 'builtin',
        label: 'builtin',
        client_id: 'builtin-public-id',
        is_active: false,
        is_builtin: true,
      },
      {
        key: 'custom',
        label: 'custom',
        client_id: 'custom-public-id',
        is_active: true,
        is_builtin: false,
      },
    ]);
    expect(JSON.stringify(clients)).not.toContain('private-client-secret');
    expect(() =>
      OAuthClientDescriptorSchema.parse({ ...clients[0], client_secret: 'private-client-secret' }),
    ).toThrow();
  });

  it('persists a selected client and rejects unknown keys without reflecting input', () => {
    setActiveOAuthClient(' CUSTOM ');
    expect(state.stored).toBe('custom');
    expect(getActiveOAuthClient()).toBe('custom');
    expect(listOAuthClients()[1]?.is_active).toBe(true);

    const submitted = 'private-client-secret';
    expect(() => setActiveOAuthClient(submitted)).toThrow('Unknown OAuth client key');
    expect(state.stored).toBe('custom');
    try {
      setActiveOAuthClient(submitted);
    } catch (error) {
      expect(String(error)).not.toContain(submitted);
    }
  });

  it('clears an invalid stored preference without logging its value', () => {
    state.stored = 'private-client-secret';
    expect(getActiveOAuthClient()).toBe('builtin');
    expect(state.stored).toBe('');
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
      'private-client-secret',
    );
  });
});
