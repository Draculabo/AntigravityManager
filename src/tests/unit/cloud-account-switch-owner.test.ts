import {
  account,
  credentialWrite,
  expectTerminalDiagnostic,
  startOwner,
} from '../support/cloud-switch-owner-fixture';
import { createRouterClient } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { cloudRouter } from '@/modules/cloud-account/ipc/router';
import { selectCloudAccountAdapter } from '@/modules/cloud-account/ipc/cloud-account-adapter';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import {
  CloudAccountRefreshBlockedError,
  CloudAccountRefreshService,
} from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { switchCloudAccountCore } from '@/modules/cloud-account/services/cloud-account-switch.service';
import { accountOwnerEvents } from '@/modules/cloud-account/services/account-owner-events.service';
import {
  getSwitchGuardSnapshot,
  runWithSwitchGuard,
} from '@/modules/antigravity-runtime/switch/switchGuard';
import { logger } from '@/shared/logging/logger';
import * as runtimeStop from '@/modules/antigravity-runtime/stop';
import * as runtimeLaunch from '@/modules/antigravity-runtime/launchContext';
import * as classicHot from '@/modules/antigravity-runtime/classicHotSwitch';
import * as clientLaunch from '@/modules/antigravity-runtime/launch';
import { SwitchTraceSchema } from '@/shared/observability/switchDiagnostic';
import { processError } from '@/modules/antigravity-runtime/processErrors';

describe('core-owned cloud account switching', () => {
  it.each(['desktop-embedded', 'standalone-core'] as const)(
    'returns success and commits active state once after a hot failure recovers (%s)',
    async (mode) => {
      if (mode === 'standalone-core') {
        selectCloudAccountAdapter({ mode, client: await startOwner() });
      }
      vi.spyOn(classicHot, 'prepareClassicHotSwitch').mockResolvedValue({
        stopServices: async () => {},
        confirmReplacement: async () => {
          throw processError('probe-failed');
        },
      });
      const stop = vi.spyOn(runtimeStop, 'stopFromContext').mockResolvedValue(undefined);
      const start = vi.spyOn(clientLaunch, 'startFromContext').mockResolvedValue({ pid: 300 });
      await expect(
        createRouterClient(cloudRouter).switchCloudAccount({ accountId: account.id }),
      ).resolves.toBeUndefined();
      expect(stop).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
      expect(credentialWrite).toHaveBeenCalledTimes(3);
      expect(CloudAccountRepo.setActive).toHaveBeenCalledExactlyOnceWith(account.id);
      const records = vi.mocked(logger.info).mock.calls;
      const trace = SwitchTraceSchema.parse(
        records.find((call) => call[0] === 'Switch trace v1')?.[1],
      );
      const diagnostic = records.find((call) => call[0] === 'Operation diagnostic v1')?.[1];
      expect(trace.outcome).toBe('recovered-by-restart');
      expect(diagnostic).toMatchObject({
        diagnosticId: trace.diagnosticId,
        reporting: { state: 'not-reported', reason: 'disabled' },
      });
      expect(records.filter((call) => call[0] === 'Operation diagnostic v1')).toHaveLength(1);
    },
  );
  it.each(['desktop-embedded', 'standalone-core'] as const)(
    'reports client discovery failure before preparing target credentials (%s)',
    async (mode) => {
      if (mode === 'standalone-core') {
        const client = await startOwner();
        selectCloudAccountAdapter({ mode, client });
      }
      const prepare = vi
        .spyOn(runtimeLaunch, 'prepareLaunchContext')
        .mockRejectedValueOnce(processError('probe-failed'));
      try {
        await expect(
          createRouterClient(cloudRouter).switchCloudAccount({ accountId: account.id }),
        ).rejects.toMatchObject({
          message: 'Cloud account switch failed',
          data: { switchCode: 'switch-failed' },
        });
        expect(credentialWrite).not.toHaveBeenCalled();
        expect(CloudAccountRepo.updateToken).not.toHaveBeenCalled();
        expect(CloudAccountRepo.setActive).not.toHaveBeenCalled();
        expectTerminalDiagnostic({
          schemaVersion: 1,
          operation: 'cloud-account-switch',
          stage: 'client-selection',
          target: 'classic',
          reason: 'unavailable',
          nativeCode: 'ANTIGRAVITY_PROCESS_FAILED',
          process: { reason: 'probe-failed' },
          rollback: 'not-attempted',
          causes: [
            {
              reason: 'unavailable',
              nativeCode: 'ANTIGRAVITY_PROCESS_FAILED',
              process: { reason: 'probe-failed' },
            },
          ],
          reporting: { state: 'not-reported', reason: 'disabled' },
        });
      } finally {
        prepare.mockRestore();
      }
    },
  );
  it('keeps a reference for a rejected concurrent switch without entering account storage', async () => {
    const release = Promise.withResolvers<void>();
    const active = runWithSwitchGuard('local-account-switch', () => release.promise);
    try {
      await expect(switchCloudAccountCore(account.id, 'ide')).rejects.toMatchObject({
        switchCode: 'switch-failed',
        diagnostic: {
          stage: 'management-transport',
          reason: 'locked',
          target: 'ide',
          reporting: { state: 'not-reported', reason: 'expected-outcome' },
        },
      });
      expect(CloudAccountRepo.getAccount).not.toHaveBeenCalled();
      expect(credentialWrite).not.toHaveBeenCalled();
      expect(getSwitchGuardSnapshot()).toEqual({ activeOwner: 'local-account-switch' });
    } finally {
      release.resolve();
      await active;
    }
  });
  it.each(['desktop-embedded', 'standalone-core'] as const)(
    'reports a refused client close without writing credentials or selecting the account (%s)',
    async (mode) => {
      if (mode === 'standalone-core') {
        const client = await startOwner();
        selectCloudAccountAdapter({ mode, client });
      }
      const stop = vi
        .spyOn(runtimeStop, 'stopFromContext')
        .mockRejectedValueOnce(processError('exit-unconfirmed'));
      try {
        await expect(
          createRouterClient(cloudRouter).switchCloudAccount({ accountId: account.id }),
        ).rejects.toMatchObject({
          message: 'Cloud account switch failed',
          data: { switchCode: 'process-close-failed' },
        });
        expect(credentialWrite).not.toHaveBeenCalled();
        expect(CloudAccountRepo.setActive).not.toHaveBeenCalled();
        expect(CloudAccountRepo.updateLastUsed).not.toHaveBeenCalled();
        expectTerminalDiagnostic({
          schemaVersion: 1,
          operation: 'cloud-account-switch',
          stage: 'process-close',
          target: 'classic',
          storage: 'credential-store',
          reason: 'process-close-failed',
          nativeCode: 'ANTIGRAVITY_PROCESS_FAILED',
          process: { reason: 'exit-unconfirmed' },
          credentialWrite: 'not-attempted',
          rollback: 'not-attempted',
          causes: [
            {
              reason: 'timed-out',
              nativeCode: 'ANTIGRAVITY_PROCESS_FAILED',
              process: { reason: 'exit-unconfirmed' },
            },
          ],
          reporting: { state: 'not-reported', reason: 'disabled' },
        });
      } finally {
        stop.mockRestore();
      }
    },
  );
  it('does not turn a presentation failure into an account switch failure', async () => {
    const cursor = accountOwnerEvents.read(undefined, 0);
    await expect(
      switchCloudAccountCore(account.id, 'agy', {
        presentationReason: 'auto',
        onSuccess: () => {
          throw new Error('Tray unavailable');
        },
      }),
    ).resolves.toBeUndefined();
    expect(CloudAccountRepo.setActive).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(accountOwnerEvents.read(cursor.epoch, cursor.latest).events).toEqual([
      {
        sequence: cursor.latest + 1,
        event: { kind: 'account-switched', accountId: account.id, target: 'agy', reason: 'auto' },
      },
    ]);
  });
  it('persists an Agy switch in the owner and reflects it through subsequent views', async () => {
    const client = await startOwner();
    selectCloudAccountAdapter({ mode: 'standalone-core', client });
    const previousStatus = await createRouterClient(cloudRouter).getSwitchStatus();
    const cursor = await client.readAccountOwnerEvents(undefined, 0);

    await expect(client.switchCloudAccount(account.id, 'agy')).resolves.toBeUndefined();
    const status = await createRouterClient(cloudRouter).getSwitchStatus();
    expect(status.metrics.cloud.switchSuccess).toBe(previousStatus.metrics.cloud.switchSuccess + 1);
    expect(status.provenance).toBe('account-owner-process');
    expect(status.guard).toEqual({ activeOwner: null });
    expect(CloudAccountRepo.updateLastUsed).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(CloudAccountRepo.setActive).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(CloudAccountSettingsStore.setActiveForTarget).toHaveBeenCalledExactlyOnceWith(
      'agy',
      account.id,
    );
    expect(credentialWrite).toHaveBeenCalledExactlyOnceWith();
    expect(await client.accountViews()).toMatchObject([
      { id: account.id, is_active: true, is_active_agy: true },
    ]);
    const events = await client.readAccountOwnerEvents(cursor.epoch, cursor.latest);
    expect(events.events).toEqual([
      {
        sequence: cursor.latest + 1,
        event: { kind: 'account-switched', accountId: account.id, target: 'agy', reason: 'manual' },
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /access_token|refresh_token|proxy_url|private-provider/,
    );
  });

  it('maps durable OAuth blocking to a value-free renderer reauth category', async () => {
    account.token.refresh_token = 'private-refresh-token';
    vi.mocked(CloudAccountRefreshService.refreshAccessToken).mockRejectedValueOnce(
      new CloudAccountRefreshBlockedError('private-provider-detail'),
    );
    const client = await startOwner();
    selectCloudAccountAdapter({ mode: 'standalone-core', client });

    try {
      await createRouterClient(cloudRouter).switchCloudAccount({ accountId: account.id });
      expect.fail('Blocked account should reject');
    } catch (error) {
      expect(error).toMatchObject({ data: { switchCode: 'reauth-required' } });
      expect(JSON.stringify(error)).not.toMatch(/private-provider-detail|private-refresh-token/);
    }
    expect(CloudAccountRepo.setActive).not.toHaveBeenCalled();
    expectTerminalDiagnostic({
      schemaVersion: 1,
      operation: 'cloud-account-switch',
      stage: 'token-refresh',
      target: 'classic',
      reason: 'reauth-required',
      rollback: 'not-attempted',
      causes: [{ reason: 'unknown' }],
      reporting: { state: 'not-reported', reason: 'disabled' },
    });
  });
  it('records a safe native write error code without changing the public error contract', async () => {
    credentialWrite.mockRejectedValueOnce(
      Object.assign(
        new Error('private-provider access_token=fixture-access /Users/alice/private'),
        { code: 'EACCES' },
      ),
    );
    const client = await startOwner();
    selectCloudAccountAdapter({ mode: 'standalone-core', client });
    await expect(
      createRouterClient(cloudRouter).switchCloudAccount({
        accountId: account.id,
        appTarget: 'agy',
      }),
    ).rejects.toMatchObject({
      message: 'Cloud account switch failed',
      data: { switchCode: 'target-write-failed' },
    });
    expectTerminalDiagnostic({
      schemaVersion: 1,
      operation: 'cloud-account-switch',
      stage: 'target-write',
      target: 'agy',
      storage: 'credential-store',
      reason: 'permission-denied',
      nativeCode: 'EACCES',
      rollback: 'not-attempted',
      causes: [{ reason: 'permission-denied', nativeCode: 'EACCES' }],
      reporting: { state: 'not-reported', reason: 'disabled' },
    });
    expect(CloudAccountRepo.setActive).not.toHaveBeenCalled();
  });
  it('reports a failed remote switch without exposing its raw diagnostic text', async () => {
    const client = await startOwner();
    selectCloudAccountAdapter({ mode: 'standalone-core', client });
    const before = await client.accountSwitchStatus();
    vi.mocked(credentialWrite).mockImplementationOnce(() => {
      throw new Error(
        'private-provider C:\\secret\\token.sqlite http://user:password@host process --credential',
      );
    });
    await expect(client.switchCloudAccount(account.id, 'agy')).rejects.toThrow();
    const status = await createRouterClient(cloudRouter).getSwitchStatus();
    expect(status.metrics.cloud.switchFailure).toBe(before.metrics.cloud.switchFailure + 1);
    expect(status.metrics.cloud.lastFailure).toEqual({
      reason: 'perform_switch_failed',
      message: 'Account switch failed.',
      occurredAt: expect.any(Number),
    });
    expect(JSON.stringify(status)).not.toMatch(
      /private-provider|token.sqlite|password|credential|private-access/,
    );
  });
  it('reads actual owner guard state while a remote switch is in flight', async () => {
    let release!: (value: typeof account) => void;
    vi.mocked(CloudAccountRepo.getAccount).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const client = await startOwner();
    const switching = client.switchCloudAccount(account.id, 'agy');
    await vi.waitFor(() =>
      expect(getSwitchGuardSnapshot().activeOwner).toBe('cloud-account-switch'),
    );
    expect((await client.accountSwitchStatus()).guard).toEqual({
      activeOwner: 'cloud-account-switch',
    });
    release(account);
    await switching;
  });
});
