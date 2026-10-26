import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { switchCloudAccountCore } from '@/modules/cloud-account/services/cloud-account-switch.service';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { accountOwnerEvents } from '@/modules/cloud-account/services/account-owner-events.service';
import { logger } from '@/shared/logging/logger';
import { account } from '../support/cloud-account-switch-owner-fixture';
import { switchContext } from '../support/runtime-switch-fixture';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  write: vi.fn(),
  stop: vi.fn(),
  start: vi.fn(),
  applyTerms: vi.fn(),
  rollbackTerms: vi.fn(),
}));
vi.mock('@/modules/cloud-account/persistence/cloudHandler', () => ({
  CloudAccountRepo: { getAccount: vi.fn(), finalizeSwitch: vi.fn() },
}));
vi.mock('@/modules/antigravity-runtime', () => ({
  prepareLaunchContext: mocks.prepare,
  prepareClientAccountWrite: vi.fn(async () => ({
    storage: 'credential-store',
    write: mocks.write,
  })),
}));
vi.mock('@/modules/antigravity-runtime/launch', () => ({ startFromContext: mocks.start }));
vi.mock('@/modules/antigravity-runtime/stop', () => ({ stopFromContext: mocks.stop }));
vi.mock('@/modules/antigravity-runtime/ideHotSwitch', () => ({
  prepareIdeHotSwitch: vi.fn(async () => null),
}));
vi.mock('@/modules/antigravity-runtime/terms/classicTermsSwitch', () => ({
  prepareClassicTermsSwitch: vi.fn(async () => ({
    apply: mocks.applyTerms,
    rollback: mocks.rollbackTerms,
  })),
}));
vi.mock('@/modules/identity-profile/ipc/handler', () => ({
  ensureGlobalOriginalFromCurrentStorage: vi.fn(),
  isIdentityProfileApplyEnabled: vi.fn(() => false),
}));
vi.mock('@/shared/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const originalPlatform = process.platform;
let officialCredentials: 'original' | 'selected';
beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  vi.clearAllMocks();
  vi.mocked(CloudAccountRepo.getAccount).mockResolvedValue(structuredClone(account));
  mocks.prepare.mockResolvedValue(switchContext);
  mocks.stop.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue(undefined);
  mocks.applyTerms.mockReset().mockResolvedValue(undefined);
  mocks.rollbackTerms.mockReset().mockResolvedValue(undefined);
  officialCredentials = 'original';
  mocks.write.mockReset().mockImplementation(async () => {
    officialCredentials = 'selected';
  });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
});

describe('cloud switch partial effects and recovery diagnostics', () => {
  it('stops after an uncertain credential write without rolling back untouched terms', async () => {
    const failure = Object.assign(new Error('private credential write detail'), { code: 'EACCES' });
    mocks.write.mockImplementationOnce(async () => {
      officialCredentials = 'selected';
      throw failure;
    });
    const cursor = accountOwnerEvents.read(undefined, 0);
    const onSuccess = vi.fn();
    await expect(
      switchCloudAccountCore(account.id, 'classic', { onSuccess }),
    ).rejects.toMatchObject({
      switchCode: 'target-write-failed',
      diagnostic: {
        stage: 'target-write',
        reason: 'permission-denied',
        nativeCode: 'EACCES',
        credentialWrite: 'uncertain',
        causes: [{ reason: 'permission-denied', nativeCode: 'EACCES' }],
      },
    });
    expect(officialCredentials).toBe('selected');
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.applyTerms).not.toHaveBeenCalled();
    expect(mocks.rollbackTerms).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(CloudAccountRepo.finalizeSwitch).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(accountOwnerEvents.read(cursor.epoch, cursor.latest).events).toEqual([]);
  });

  it('keeps both terms-write and recovery failures while stopping success and retry', async () => {
    const failure = Object.assign(new Error('access_token=private write detail'), {
      code: 'EACCES',
    });
    const recovery = Object.assign(new Error('private rollback path'), { code: 'EIO' });
    mocks.applyTerms.mockRejectedValueOnce(failure);
    mocks.rollbackTerms.mockRejectedValueOnce(recovery);
    const cursor = accountOwnerEvents.read(undefined, 0);
    const onSuccess = vi.fn();
    let thrown: unknown;
    try {
      await switchCloudAccountCore(account.id, 'classic', { onSuccess });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      switchCode: 'target-write-failed',
      diagnostic: {
        stage: 'target-write',
        reason: 'permission-denied',
        nativeCode: 'EACCES',
        rollback: 'not-attempted',
        causes: [
          { reason: 'unknown' },
          { reason: 'permission-denied', nativeCode: 'EACCES' },
          { reason: 'storage-failed', nativeCode: 'EIO' },
        ],
      },
    });
    expect(JSON.stringify(thrown)).not.toMatch(/private|access_token/);
    expect(officialCredentials).toBe('selected');
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.rollbackTerms).toHaveBeenCalledOnce();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(CloudAccountRepo.finalizeSwitch).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(accountOwnerEvents.read(cursor.epoch, cursor.latest).events).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Cloud account switch stopped before completion',
      expect.objectContaining({ errors: [failure, recovery] }),
    );
  });

  it('retains the startup cause without claiming credential recovery after launch dispatch', async () => {
    const failure = Object.assign(new Error('private launch detail'), { code: 'EPERM' });
    mocks.start.mockRejectedValueOnce(failure);
    const onSuccess = vi.fn();
    const cursor = accountOwnerEvents.read(undefined, 0);
    await expect(
      switchCloudAccountCore(account.id, 'classic', { onSuccess }),
    ).rejects.toMatchObject({
      switchCode: 'process-control-failed',
      diagnostic: {
        stage: 'process-start',
        reason: 'process-start-failed',
        nativeCode: 'ANTIGRAVITY_PROCESS_FAILED',
        process: { reason: 'switched-startup-unconfirmed' },
        rollback: 'not-attempted',
        causes: [
          {
            reason: 'unavailable',
            nativeCode: 'ANTIGRAVITY_PROCESS_FAILED',
            process: { reason: 'switched-startup-unconfirmed' },
          },
          { reason: 'permission-denied', nativeCode: 'EPERM' },
        ],
      },
    });
    expect(officialCredentials).toBe('selected');
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.rollbackTerms).not.toHaveBeenCalled();
    expect(CloudAccountRepo.finalizeSwitch).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(accountOwnerEvents.read(cursor.epoch, cursor.latest).events).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Cloud account switch stopped before completion',
      expect.objectContaining({ cause: failure }),
    );
  });
});
