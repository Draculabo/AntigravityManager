import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreateServer, mockLogger } = vi.hoisted(() => ({
  mockCreateServer: vi.fn(),
  mockLogger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('http', () => ({
  default: {
    createServer: mockCreateServer,
  },
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: mockLogger,
}));

vi.mock('@/ipc/context', () => ({
  ipcContext: {
    mainWindow: null,
  },
}));

vi.mock('@/shared/utils/url', () => ({
  escapeHtml: (value: string) => value,
}));

import { AuthServer } from '@/modules/cloud-account/ipc/authServer';

type ErrorListener = (error: Error) => void;

function createMockServer({ failListen = false }: { failListen?: boolean } = {}) {
  let pendingErrorListener: ErrorListener | null = null;

  const server = {
    close: vi.fn((callback?: (error?: Error) => void) => {
      callback?.();
      return server;
    }),
    closeAllConnections: vi.fn(),
    listen: vi.fn((_port: number, _host: string, callback: () => void) => {
      if (failListen) {
        pendingErrorListener?.(
          Object.assign(new Error('listen EADDRINUSE: address already in use'), {
            code: 'EADDRINUSE',
          }),
        );
      } else {
        callback();
      }
      return server;
    }),
    off: vi.fn((_event: string, listener: ErrorListener) => {
      if (pendingErrorListener === listener) {
        pendingErrorListener = null;
      }
      return server;
    }),
    on: vi.fn(() => server),
    once: vi.fn((event: string, listener: ErrorListener) => {
      if (event === 'error') {
        pendingErrorListener = listener;
      }
      return server;
    }),
  };

  return server;
}

describe('OAuth callback server port binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await AuthServer.stop();
  });

  it('keeps the selected port bound instead of probing and releasing it first', async () => {
    const server = createMockServer();
    mockCreateServer.mockReturnValue(server);

    await AuthServer.start();

    expect(mockCreateServer).toHaveBeenCalledTimes(1);
    expect(server.listen).toHaveBeenCalledTimes(1);
    expect(server.listen).toHaveBeenCalledWith(8888, '127.0.0.1', expect.any(Function));
    expect(server.close).not.toHaveBeenCalled();
    expect(AuthServer.getRedirectUri()).toBe('http://localhost:8888/oauth-callback');
  });

  it('moves to the next port when the real listen receives EADDRINUSE', async () => {
    const occupiedServer = createMockServer({ failListen: true });
    const fallbackServer = createMockServer();
    mockCreateServer
      .mockReturnValueOnce(occupiedServer)
      .mockReturnValueOnce(fallbackServer);

    await AuthServer.start();

    expect(mockCreateServer).toHaveBeenCalledTimes(2);
    expect(occupiedServer.listen).toHaveBeenCalledWith(8888, '127.0.0.1', expect.any(Function));
    expect(fallbackServer.listen).toHaveBeenCalledWith(8889, '127.0.0.1', expect.any(Function));
    expect(AuthServer.getRedirectUri()).toBe('http://localhost:8889/oauth-callback');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'AuthServer: Using fallback port 8889 (default 8888 is in use)',
    );
  });
});
