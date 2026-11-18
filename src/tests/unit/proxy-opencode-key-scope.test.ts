import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '@/server/gateway/guards/admin.guard';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';

const credentialMocks = vi.hoisted(() => ({
  matches: vi.fn(),
}));

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: credentialMocks,
}));

vi.mock('@/server/server-config', () => ({
  getServerConfig: () => ({
    ...DEFAULT_APP_CONFIG.proxy,
    api_key: 'global-admin-key',
  }),
}));

function createContext(token: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: {
          authorization: `Bearer ${token}`,
        },
        ip: '127.0.0.1',
      }),
    }),
  } as ExecutionContext;
}

describe('OpenCode dedicated key scope', () => {
  beforeEach(() => {
    credentialMocks.matches.mockReset();
    credentialMocks.matches.mockImplementation(
      (candidate) => candidate === 'dedicated-opencode-key',
    );
  });

  it('accepts the dedicated key on model proxy routes', () => {
    const guard = new ProxyGuard();

    expect(guard.canActivate(createContext('dedicated-opencode-key'))).toBe(true);
  });

  it('falls through to the configured proxy API key when OpenCode matching throws', () => {
    credentialMocks.matches.mockImplementation(() => {
      throw new Error("Value of 'keychain' is invalid: 'antigravity-manager:opencode'");
    });
    const guard = new ProxyGuard();

    expect(guard.canActivate(createContext('global-admin-key'))).toBe(true);
  });

  it('does not accept the dedicated key on admin routes', () => {
    const guard = new AdminGuard();

    expect(() => guard.canActivate(createContext('dedicated-opencode-key'))).toThrow(
      UnauthorizedException,
    );
    expect(credentialMocks.matches).not.toHaveBeenCalled();
  });
});
