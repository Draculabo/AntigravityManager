import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutoSwitchService } from '@/services/AutoSwitchService';
import { CloudAccountRepo } from '@/ipc/database/cloudHandler';
import { switchCloudAccount } from '@/ipc/cloud/handler';
import { NotificationService } from '@/services/NotificationService';
import { CloudAccount } from '@/types/cloudAccount';

// Mock dependencies
vi.mock('@/ipc/database/cloudHandler', () => ({
  CloudAccountRepo: {
    getSetting: vi.fn(),
    getSettingAsync: vi.fn(),
    getAccounts: vi.fn(),
  },
}));

vi.mock('@/ipc/cloud/handler', () => ({
  switchCloudAccount: vi.fn(),
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/services/NotificationService', () => ({
  NotificationService: {
    sendAutoSwitchNotification: vi.fn(),
    sendQuotaWarningNotification: vi.fn(),
    sendAllDepletedNotification: vi.fn(),
    sendSwitchFailedNotification: vi.fn(),
    getSwitchThreshold: vi.fn().mockReturnValue(5),
    getSwitchThresholdAsync: vi.fn().mockResolvedValue(5),
    getWarningThreshold: vi.fn().mockReturnValue(20),
    getWarningThresholdAsync: vi.fn().mockResolvedValue(20),
  },
}));

describe('AutoSwitchService', () => {
  const mockCurrentAccount: CloudAccount = {
    id: 'current-id',
    email: 'current@test.com',
    is_active: true,
    status: 'active',
    quota: {
      models: {
        'gemini-pro': { percentage: 2, resetTime: '2026-02-03T00:00:00Z' }, // Depleted (< 5%)
      },
      updated_at: Date.now(),
    },
    // ...other props
  } as any;

  const mockNextAccount: CloudAccount = {
    id: 'next-id',
    email: 'next@test.com',
    is_active: false,
    status: 'active',
    quota: {
      models: {
        'gemini-pro': { percentage: 80, resetTime: '2026-02-03T00:00:00Z' },
      },
      updated_at: Date.now(),
    },
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkAndSwitchIfNeeded', () => {
    it('should switch account and notify when current is depleted', async () => {
      // Mock Auto Switch enabled
      vi.mocked(CloudAccountRepo.getSettingAsync).mockResolvedValue(true);

      // Mock accounts (current is depleted, next is healthy)
      vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([
        mockCurrentAccount,
        mockNextAccount,
      ]);

      // Mock switch thresholds
      vi.mocked(NotificationService.getSwitchThresholdAsync).mockResolvedValue(5);

      const result = await AutoSwitchService.checkAndSwitchIfNeeded();

      expect(result).toBe(true);
      expect(switchCloudAccount).toHaveBeenCalledWith(mockNextAccount.id);
      expect(NotificationService.sendAutoSwitchNotification).toHaveBeenCalledWith(
        mockCurrentAccount.email,
        mockNextAccount.email,
      );
    });

    it('should NOT switch if disabled', async () => {
      vi.mocked(CloudAccountRepo.getSettingAsync).mockResolvedValue(false);

      const result = await AutoSwitchService.checkAndSwitchIfNeeded();

      expect(result).toBe(false);
      expect(switchCloudAccount).not.toHaveBeenCalled();
      expect(NotificationService.sendAutoSwitchNotification).not.toHaveBeenCalled();
    });

    it('should NOT switch if current account is healthy', async () => {
      vi.mocked(CloudAccountRepo.getSettingAsync).mockResolvedValue(true);

      const healthyAccount = {
        ...mockCurrentAccount,
        quota: { models: { 'gemini-pro': { percentage: 10, resetTime: '2026-02-03T00:00:00Z' } } }, // 10 > 5
      };
      vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([healthyAccount, mockNextAccount]);
      vi.mocked(NotificationService.getSwitchThresholdAsync).mockResolvedValue(5);

      const result = await AutoSwitchService.checkAndSwitchIfNeeded();

      expect(result).toBe(false);
      expect(switchCloudAccount).not.toHaveBeenCalled();
    });

    it('should send depleted notification if no healthy accounts available', async () => {
      vi.mocked(CloudAccountRepo.getSettingAsync).mockResolvedValue(true);

      const depletedNext = {
        ...mockNextAccount,
        quota: { models: { 'gemini-pro': { percentage: 1, resetTime: '2026-02-03T00:00:00Z' } } },
      };

      vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([mockCurrentAccount, depletedNext]);
      vi.mocked(NotificationService.getSwitchThresholdAsync).mockResolvedValue(5);

      const result = await AutoSwitchService.checkAndSwitchIfNeeded();

      expect(result).toBe(false); // Did not switch
      expect(switchCloudAccount).not.toHaveBeenCalled();
      expect(NotificationService.sendAllDepletedNotification).toHaveBeenCalled();
      // Ensure we don't send switch notification when we didn't switch
      expect(NotificationService.sendAutoSwitchNotification).not.toHaveBeenCalled();
    });
  });
});
