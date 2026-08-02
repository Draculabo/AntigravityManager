import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '@/modules/proxy-gateway/server/guards/admin.guard';
import { ProxyGuard } from '@/modules/proxy-gateway/server/proxy.guard';

const credentialMocks = vi.hoisted(() => ({
  matches: vi.fn(),
}));

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: credentialMocks,
}));

vi.mock('@/server/server-config', () => ({
  getServerConfig: () => ({
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

  it('does not accept the dedicated key on admin routes', () => {
    const guard = new AdminGuard();

    expect(() => guard.canActivate(createContext('dedicated-opencode-key'))).toThrow(
      UnauthorizedException,
    );
    expect(credentialMocks.matches).not.toHaveBeenCalled();
  });
});
