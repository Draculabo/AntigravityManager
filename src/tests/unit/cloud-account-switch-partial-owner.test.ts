import { account, credentialWrite, startOwner } from '../support/cloud-switch-owner-fixture';
import { createRouterClient } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { cloudRouter } from '@/modules/cloud-account/ipc/router';
import { selectCloudAccountAdapter } from '@/modules/cloud-account/ipc/cloud-account-adapter';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';

import * as runtimeStop from '@/modules/antigravity-runtime/stop';
import * as classicHot from '@/modules/antigravity-runtime/classicHotSwitch';
import * as clientLaunch from '@/modules/antigravity-runtime/launch';
import { processError, processOwnershipError } from '@/modules/antigravity-runtime/processErrors';

describe('Partial cloud account switching across owners', () => {
  it.each(['desktop-embedded', 'standalone-core'] as const)(
    'preserves a confirmed partial write and identity evidence across the owner boundary (%s)',
    async (mode) => {
      if (mode === 'standalone-core') {
        selectCloudAccountAdapter({ mode, client: await startOwner() });
      }
      const ownership = {
        reason: 'main-missing' as const,
        capturedCount: 2,
        observedCount: 1,
        matchedCount: 1,
      };
      vi.spyOn(classicHot, 'prepareClassicHotSwitch').mockResolvedValue({
        stopServices: async () => {},
        confirmReplacement: async () => {
          throw processOwnershipError('switched-hot-unconfirmed', ownership);
        },
      });
      vi.spyOn(runtimeStop, 'stopFromContext').mockRejectedValueOnce(
        processError('exit-unconfirmed'),
      );
      const start = vi.spyOn(clientLaunch, 'startFromContext');
      await expect(
        createRouterClient(cloudRouter).switchCloudAccount({ accountId: account.id }),
      ).rejects.toMatchObject({
        data: {
          diagnostic: {
            credentialWrite: 'confirmed',
            causes: expect.arrayContaining([
              expect.objectContaining({
                process: { reason: 'switched-hot-unconfirmed', ownership },
              }),
            ]),
          },
        },
      });
      expect(credentialWrite).toHaveBeenCalledTimes(2);
      expect(start).not.toHaveBeenCalled();
      expect(CloudAccountRepo.setActive).not.toHaveBeenCalled();
      expect(CloudAccountRepo.updateLastUsed).not.toHaveBeenCalled();
    },
  );
});
