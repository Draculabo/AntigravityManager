import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mainWindow: undefined as unknown,
}));

vi.mock('@/ipc/context', () => ({
  ipcContext: {
    get mainWindow() {
      return mocks.mainWindow;
    },
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

async function requestCallbackOnce(url: string): Promise<{ body: string; status: number }> {
  return await new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({ body, status: response.statusCode ?? 0 });
      });
    });
    request.on('error', reject);
  });
}

async function requestCallback(url: string): Promise<{ body: string; status: number }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await requestCallbackOnce(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

describe('AuthServer authorization delivery', () => {
  afterEach(async () => {
    mocks.mainWindow = undefined;
    await AuthServer.stop();
  });

  it('does not report success when no renderer can receive the authorization code', async () => {
    await AuthServer.start();

    const response = await requestCallback(`${AuthServer.getRedirectUri()}?code=test-code`);

    expect(response.status).toBe(503);
    expect(response.body).toContain('Login Failed');
    expect(response.body).not.toContain('Login Successful');
  });

  it('does not report success when the main window has been destroyed', async () => {
    const send = vi.fn();
    mocks.mainWindow = {
      isDestroyed: () => true,
      webContents: {
        isDestroyed: () => false,
        send,
      },
    };
    await AuthServer.start();

    const response = await requestCallback(`${AuthServer.getRedirectUri()}?code=test-code`);

    expect(response.status).toBe(503);
    expect(response.body).toContain('Login Failed');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not report success when the renderer process has been destroyed', async () => {
    const send = vi.fn();
    mocks.mainWindow = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => true,
        send,
      },
    };
    await AuthServer.start();

    const response = await requestCallback(`${AuthServer.getRedirectUri()}?code=test-code`);

    expect(response.status).toBe(503);
    expect(response.body).toContain('Login Failed');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not report success when IPC delivery throws', async () => {
    const send = vi.fn(() => {
      throw new Error('renderer unavailable');
    });
    mocks.mainWindow = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send,
      },
    };
    await AuthServer.start();

    const response = await requestCallback(`${AuthServer.getRedirectUri()}?code=test-code`);

    expect(response.status).toBe(503);
    expect(response.body).toContain('Login Failed');
    expect(send).toHaveBeenCalledWith('GOOGLE_AUTH_CODE', 'test-code');
  });
});
