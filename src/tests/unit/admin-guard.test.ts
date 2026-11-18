import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { AdminGuard } from '@/server/gateway/guards/admin.guard';
import { setServerConfig } from '@/server/server-config';

function createContext(headers: Record<string, string> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as ExecutionContext;
}

describe('AdminGuard', () => {
  it('rejects admin requests when no API key is configured', () => {
    setServerConfig({
      ...DEFAULT_APP_CONFIG.proxy,
      api_key: '',
    });

    expect(() => new AdminGuard().canActivate(createContext())).toThrow(UnauthorizedException);
  });

  it('accepts admin requests with the configured API key', () => {
    setServerConfig({
      ...DEFAULT_APP_CONFIG.proxy,
      api_key: 'admin-key',
    });

    expect(new AdminGuard().canActivate(createContext({ authorization: 'Bearer admin-key' }))).toBe(
      true,
    );
  });
});
