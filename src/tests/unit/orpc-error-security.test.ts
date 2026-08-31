import { afterEach, describe, expect, it, vi } from 'vitest';
import { toPublicORPCError } from '@/ipc/router';

describe('ORPC public error details', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not expose backend stacks in production ORPC errors', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const error = new Error('database unavailable');
    error.stack = 'Error: database unavailable\n    at C:\\private\\server.ts:1:1';

    const publicError = toPublicORPCError(error, 'cloud.list');

    expect(publicError.data).toMatchObject({
      backendName: 'Error',
      backendMessage: 'database unavailable',
      requestPath: 'cloud.list',
    });
    expect(publicError.data).not.toHaveProperty('backendStack');
  });

  it('keeps backend stacks available in development ORPC errors', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const error = new Error('database unavailable');
    error.stack = 'Error: database unavailable\n    at C:\\private\\server.ts:1:1';

    const publicError = toPublicORPCError(error, 'cloud.list');

    expect(publicError.data).toMatchObject({
      backendStack: error.stack,
    });
  });
});
