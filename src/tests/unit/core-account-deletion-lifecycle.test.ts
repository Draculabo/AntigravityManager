import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createCoreRpcOperations } from '@/core/rpc/router';
import { deleteCloudAccount } from '@/modules/cloud-account/services/cloud-account-deletion.service';
import { serviceConfigService } from '@/modules/config/service-config.service';
import { mockCoreGatewayLifecycle } from '../support/core-gateway-lifecycle';

afterEach(() => vi.restoreAllMocks());

vi.mock('@/modules/cloud-account/services/cloud-account-deletion.service', () => ({
  deleteCloudAccount: vi.fn(),
}));

it('drains admitted deletion and rejects a new deletion after shutdown admission closes', async () => {
  const entered = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  vi.mocked(deleteCloudAccount).mockImplementation(async () => {
    entered.resolve();
    await completed.promise;
  });
  const operations = createCoreRpcOperations(mockCoreGatewayLifecycle());
  const pending = operations.accountDelete('deleted-a');
  await entered.promise;
  operations.closeAccountMutationAdmission();
  let drained = false;
  const drain = operations.drainAccountMutations().then(() => {
    drained = true;
  });
  try {
    await expect(operations.accountDelete('other-b')).rejects.toThrow('shutting down');
    // Yield to pending drain continuations; completion is controlled by the owned write gate.
    await setImmediate();
    expect(drained).toBe(false);
    expect(deleteCloudAccount).toHaveBeenCalledExactlyOnceWith('deleted-a');
  } finally {
    completed.resolve();
    await pending;
    await drain;
  }
  expect(drained).toBe(true);
});

it('keeps configuration admission open until admitted deletion has enqueued its cleanup', async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let configClosed = false;
  vi.spyOn(serviceConfigService, 'closeAdmission').mockImplementation(() => {
    configClosed = true;
  });
  vi.spyOn(serviceConfigService, 'drain').mockResolvedValue();
  const clear = vi
    .spyOn(serviceConfigService, 'clearDeletedAccountPreference')
    .mockImplementation(async () => {
      if (configClosed) {
        throw new Error('configuration closed before admitted deletion');
      }
    });
  vi.mocked(deleteCloudAccount).mockImplementation(async (accountId) => {
    entered.resolve();
    await resume.promise;
    await serviceConfigService.clearDeletedAccountPreference(accountId);
  });
  const operations = createCoreRpcOperations(mockCoreGatewayLifecycle());
  const pending = operations.accountDelete('deleted-a');
  await entered.promise;
  operations.closeAccountMutationAdmission();
  const draining = operations.drainAccountMutations();
  await setImmediate();
  expect(configClosed).toBe(false);
  resume.resolve();
  await pending;
  await draining;
  expect(clear).toHaveBeenCalledExactlyOnceWith('deleted-a');
  expect(configClosed).toBe(true);
});
