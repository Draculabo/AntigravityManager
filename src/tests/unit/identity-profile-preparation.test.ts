import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processError } from '@/modules/antigravity-runtime/processErrors';
import { switchContext } from '../support/runtime-switch-fixture';
import { prepareDesktopIdentityStorage } from '@/modules/identity-profile/public';

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), initialize: vi.fn(), baseline: vi.fn() }));
vi.mock('@/modules/antigravity-runtime', () => ({ prepareLaunchContext: mocks.prepare }));
vi.mock('@/modules/identity-profile/ipc/handler', () => ({
  ensureIdentityProfileStorage: mocks.initialize,
  ensureGlobalOriginalFromCurrentStorage: mocks.baseline,
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.prepare.mockResolvedValue(switchContext);
});

describe('account identity storage preparation', () => {
  it('uses the captured native Linux/custom directory rather than WSL Windows defaults', async () => {
    const options = {
      userDataDir: '/fixture/custom',
      isWsl: false,
      executablePath: '/fixture/antigravity',
    };
    mocks.prepare.mockResolvedValue({ ...switchContext, pathOptions: options });
    await prepareDesktopIdentityStorage('ide');
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith('ide');
    expect(mocks.initialize).toHaveBeenCalledExactlyOnceWith('ide', options);
    expect(mocks.baseline).toHaveBeenCalledExactlyOnceWith('ide', options);
  });

  it('allows account collection before installing a desktop application', async () => {
    mocks.prepare.mockRejectedValue(processError('missing-executable'));
    await prepareDesktopIdentityStorage();
    const options = { isWsl: false, ignoreRunningProcessCache: true };
    expect(mocks.initialize).toHaveBeenCalledExactlyOnceWith('classic', options);
    expect(mocks.baseline).toHaveBeenCalledExactlyOnceWith('classic', options);
  });

  it.each(['target-conflict', 'directory-conflict', 'probe-failed'] as const)(
    'does not initialize a profile on %s',
    async (reason) => {
      const error = processError(reason);
      mocks.prepare.mockRejectedValue(error);
      await expect(prepareDesktopIdentityStorage()).rejects.toBe(error);
      expect(mocks.initialize).not.toHaveBeenCalled();
      expect(mocks.baseline).not.toHaveBeenCalled();
    },
  );
});
