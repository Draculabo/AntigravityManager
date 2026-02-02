import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationService } from '@/services/NotificationService';
import { ConfigManager } from '@/ipc/config/manager';
import { Notification } from 'electron';
import { logger } from '@/utils/logger';

// Mock path to avoid issues with process.resourcesPath being undefined
vi.mock('path', async (importOriginal) => {
  // @ts-ignore
  const actual = await importOriginal();
  return {
    ...actual,
    join: (...args: any[]) => args.join('/'),
  };
});

// Mock Electron
vi.mock('electron', () => {
  return {
    Notification: vi.fn(),
    nativeImage: {
      createFromPath: vi.fn().mockReturnValue({
        isEmpty: vi.fn().mockReturnValue(false),
      }),
    },
    app: {
      getAppPath: vi.fn().mockReturnValue('/mock/app/path'),
    },
  };
});

// Mock Logger
vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock ConfigManager
vi.mock('@/ipc/config/manager', () => ({
  ConfigManager: {
    getCachedConfig: vi.fn(),
    loadConfig: vi.fn(),
  },
}));

describe('NotificationService', () => {
  const mockShow = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    NotificationService.clearDebounceCache();

    // Mock __dirname for Vitest environment
    // @ts-ignore
    global.__dirname = '/mock/dirname';

    // Ensure process.resourcesPath is safe
    if (typeof process.resourcesPath === 'undefined') {
      // @ts-ignore
      process.resourcesPath = '/mock/resources';
    }

    // Setup Electron Notification mock
    // Use a regular function instead of arrow function for constructor
    vi.mocked(Notification).mockImplementation(function () {
      return {
        show: mockShow,
      };
    } as any);

    // Default config mock
    vi.mocked(ConfigManager.getCachedConfig).mockReturnValue({
      // @ts-ignore
      notifications: {
        enabled: true,
        quota_warning_threshold: 20,
        quota_switch_threshold: 5,
      },
    });
  });

  describe('sendAutoSwitchNotification', () => {
    it('should send notification when enabled', () => {
      NotificationService.sendAutoSwitchNotification('old@test.com', 'new@test.com');

      const mockedLogger = vi.mocked(logger);
      if (mockedLogger.error.mock.calls.length > 0) {
        console.log('Logger Error:', JSON.stringify(mockedLogger.error.mock.calls, null, 2));
      }

      expect(mockShow).toHaveBeenCalled();
      expect(Notification).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Account Switched',
          body: expect.stringContaining('old@test.com'),
        }),
      );
    });

    it('should NOT send notification when disabled', () => {
      vi.mocked(ConfigManager.getCachedConfig).mockReturnValue({
        // @ts-ignore
        notifications: { enabled: false },
      });

      NotificationService.sendAutoSwitchNotification('old@test.com', 'new@test.com');
      expect(mockShow).not.toHaveBeenCalled();
    });

    it('should debounce repeated notifications', () => {
      NotificationService.sendAutoSwitchNotification('old@test.com', 'new@test.com');
      expect(mockShow).toHaveBeenCalledTimes(1);

      NotificationService.sendAutoSwitchNotification('old@test.com', 'new@test.com');
      expect(mockShow).toHaveBeenCalledTimes(1); // Should still be 1
    });
  });

  describe('sendQuotaWarningNotification', () => {
    it('should send warning notification', () => {
      NotificationService.sendQuotaWarningNotification('user@test.com', 15);
      expect(mockShow).toHaveBeenCalled();
      expect(Notification).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Low Quota Warning',
          body: expect.stringContaining('15.0%'),
        }),
      );
    });
  });

  describe('sendAllDepletedNotification', () => {
    it('should send critical notification', () => {
      NotificationService.sendAllDepletedNotification();
      expect(mockShow).toHaveBeenCalled();
      expect(Notification).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'All Accounts Depleted',
          urgency: 'critical',
        }),
      );
    });
  });
});
