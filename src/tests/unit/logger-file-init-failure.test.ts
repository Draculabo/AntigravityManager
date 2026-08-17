import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rotateTransportConstructor } = vi.hoisted(() => ({
  rotateTransportConstructor: vi.fn(),
}));

vi.mock('winston-daily-rotate-file', () => ({
  default: class MockDailyRotateFile {
    constructor() {
      rotateTransportConstructor();
      throw new Error('transport_init_failed');
    }
  },
}));

vi.mock('../../shared/platform/paths', () => ({
  getAgentDir: vi.fn(() => '/tmp/agm-logger-init-failure'),
}));

describe('Logger file initialization failure isolation', () => {
  beforeEach(() => {
    rotateTransportConstructor.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('keeps console logging available when rotating file transport creation fails', async () => {
    vi.resetModules();
    const { logger } = await import('../../shared/logging/logger');

    expect(() => logger.enableFileLogging('/tmp/agm-logger-init-failure')).not.toThrow();
    expect(rotateTransportConstructor).toHaveBeenCalledTimes(1);
    expect(() => logger.info('application still starts')).not.toThrow();
  });

  it('allows a later retry after initialization failure', async () => {
    vi.resetModules();
    const { logger } = await import('../../shared/logging/logger');

    logger.enableFileLogging('/tmp/agm-logger-init-failure');
    logger.enableFileLogging('/tmp/agm-logger-init-failure');

    expect(rotateTransportConstructor).toHaveBeenCalledTimes(2);
  });
});
