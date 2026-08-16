import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/modules/config/types';

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('fs', () => ({
  default: fsMock,
}));

vi.mock('os', () => ({
  default: {
    homedir: () => '/home/test-user',
  },
}));

vi.mock('electron', () => ({
  app: {
    getName: vi.fn(() => 'Antigravity Manager'),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false, wasOpenedAtLogin: false })),
    setLoginItemSettings: vi.fn(),
  },
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: loggerMock,
}));

import { syncAutoStart } from '@/modules/antigravity-runtime/utils/autoStart';

const originalPlatform = process.platform;

describe('Linux auto-start error isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('does not fail application startup when the autostart file cannot be written', () => {
    fsMock.existsSync.mockReturnValue(false);
    const writeError = new Error('EACCES: permission denied');
    fsMock.writeFileSync.mockImplementation(() => {
      throw writeError;
    });

    expect(() => syncAutoStart({ auto_startup: true } as AppConfig)).not.toThrow();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'AutoStart: Failed to update Linux autostart entry',
      writeError,
    );
  });

  it('does not fail application startup when a stale autostart entry cannot be removed', () => {
    fsMock.existsSync.mockReturnValue(true);
    const unlinkError = new Error('EACCES: permission denied');
    fsMock.unlinkSync.mockImplementation(() => {
      throw unlinkError;
    });

    expect(() => syncAutoStart({ auto_startup: false } as AppConfig)).not.toThrow();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'AutoStart: Failed to update Linux autostart entry',
      unlinkError,
    );
  });
});
