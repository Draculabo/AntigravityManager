import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ipc/context', () => ({
  ipcContext: {
    mainWindow: undefined,
  },
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { AuthServer } from '@/modules/cloud-account/ipc/authServer';

async function fetchCallback(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

describe('AuthServer authorization delivery', () => {
  afterEach(async () => {
    await AuthServer.stop();
  });

  it('does not report success when no renderer can receive the authorization code', async () => {
    await AuthServer.start();

    const response = await fetchCallback(`${AuthServer.getRedirectUri()}?code=test-code`);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain('Login Failed');
    expect(body).not.toContain('Login Successful');
  });
});
