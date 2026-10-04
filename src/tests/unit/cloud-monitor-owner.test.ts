import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRouterClient } from '@orpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreRpcClient } from '@/core/rpc/client';
import { ManagementServer } from '@/core/management/server';
import { createCoreRpcOperations } from '@/core/rpc/router';
import { createCoreShutdown } from '@/core/shutdown';
import { cloudRouter } from '@/modules/cloud-account/ipc/router';
import { selectCloudAccountAdapter } from '@/modules/cloud-account/ipc/cloud-account-adapter';
import { CloudMonitorService } from '@/modules/cloud-account/services/CloudMonitorService';
import { AutoSwitchService } from '@/modules/cloud-account/services/AutoSwitchService';
import { switchCloudAccountCore } from '@/modules/cloud-account/services/cloud-account-switch.service';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { cloudAccountWeeklyWarmupRunner } from '@/modules/cloud-account/services/cloud-account-weekly-warmup-runner';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { configureCoreOwnerPresentation } from '@/modules/cloud-account/services/account-owner-presentation.service';
import { accountOwnerEvents } from '@/modules/cloud-account/services/account-owner-events.service';

const settings = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/modules/cloud-account/ipc/handler', () => ({}));
vi.mock('@/modules/cloud-account/persistence/cloudHandler', () => ({
  CloudAccountRepo: {
    getAccounts: vi.fn(async () => []),
    updateToken: vi.fn(),
    updateQuota: vi.fn(),
    setAccountStatus: vi.fn(),
  },
}));
vi.mock('@/modules/cloud-account/persistence/cloud-account-settings-store', () => ({
  CloudAccountSettingsStore: {
    getSetting: (key: string, fallback: unknown) => settings.get(key) ?? fallback,
    readSetting: (key: string) => settings.get(key),
    setSetting: (key: string, value: unknown) => {
      settings.set(key, value);
    },
    getActiveAccountIdForTarget: vi.fn(() => 'current'),
  },
}));
vi.mock('@/modules/cloud-account/services/cloud-account-switch.service', () => ({
  switchCloudAccountCore: vi.fn(async () => {}),
}));
vi.mock('@/modules/cloud-account/services/GoogleAPIService', () => ({
  GoogleAPIService: { fetchQuota: vi.fn(), fetchAICredits: vi.fn(async () => null) },
}));
vi.mock('@/modules/cloud-account/services/CloudAccountHealthService', () => ({
  clearValidationHealthAfterSuccessfulProbe: vi.fn(),
}));
vi.mock('@/shared/platform/paths', async (original) => ({
  ...(await original<typeof import('@/shared/platform/paths')>()),
  getAntigravityStoragePaths: vi.fn(() => []),
}));
vi.mock('@/modules/antigravity-runtime/binary-patch/agyCliPathDetection', () => ({
  detectAgyCliExecutablePath: vi.fn(() => null),
}));

let server: ManagementServer | null;
let directory: string;
const renderer = createRouterClient(cloudRouter);

function account(id: string, percentage: number): CloudAccount {
  return {
    id,
    provider: 'google',
    email: `${id}@example.com`,
    token: {
      access_token: 'fixture-secret',
      refresh_token: 'fixture-refresh',
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 7200,
      token_type: 'Bearer',
    },
    created_at: 1,
    last_used: 1,
    status: 'active',
    is_active: id === 'current',
    quota: { models: { 'claude-sonnet': { percentage, resetTime: '' } } },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  settings.clear();
  vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([]);
  CloudMonitorService.resetStateForTesting();
  CloudMonitorService.configureEffects({ onQuotaUpdated: () => {} });
  AutoSwitchService.configureEffects({
    switchAccount: switchCloudAccountCore,
    onSwitched: () => {},
  });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-monitor-owner-'));
  selectCloudAccountAdapter({ mode: 'desktop-embedded' });
});
afterEach(async () => {
  CloudMonitorService.closeAdmission();
  await CloudMonitorService.drain();
  await server?.close();
  server = null;
  selectCloudAccountAdapter({ mode: 'desktop-embedded' });
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

async function remote() {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\agm-monitor-${path.basename(directory)}`
      : path.join(directory, 'core.sock');
  const operations = createCoreRpcOperations({ startGateway: vi.fn(), stopGateway: vi.fn() });
  server = new ManagementServer({
    endpoint,
    getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
    shutdown: async () => {},
    onShutdownError: vi.fn(),
    rpc: operations,
  });
  await server.start();
  selectCloudAccountAdapter({ mode: 'standalone-core', client: new CoreRpcClient(endpoint) });
  return operations;
}

describe.each(['desktop-embedded', 'standalone-core'] as const)('%s monitor controls', (mode) => {
  beforeEach(async () => {
    if (mode === 'standalone-core') {
      await remote();
    }
  });
  it('preserves configuration and starts/stops owner scheduling', async () => {
    const models = { 'claude-sonnet': { enabled: true, priority: true } };
    await renderer.setAutoSwitchModelsConfig(models);
    expect(await renderer.getAutoSwitchModelsConfig()).toEqual(models);
    await renderer.setAutoSwitchEnabled({ enabled: true });
    expect(await renderer.getAutoSwitchEnabled()).toBe(true);
    expect(CloudMonitorService.isContinuousPollingEnabled()).toBe(true);
    await renderer.setAutoSwitchEnabled({ enabled: false });
    await renderer.setWeeklyWarmupConfig({ enabled: true, groups: ['gemini'] });
    expect(await renderer.getWeeklyWarmupConfig()).toEqual({ enabled: true, groups: ['gemini'] });
    expect(CloudMonitorService.isContinuousPollingEnabled()).toBe(true);
    await renderer.setWeeklyWarmupConfig({ enabled: false, groups: ['gemini'] });
    expect(CloudMonitorService.isContinuousPollingEnabled()).toBe(false);
  });
  it('returns stable errors and rejects malformed or oversized controls', async () => {
    vi.mocked(CloudAccountRepo.getAccounts).mockRejectedValueOnce(
      new Error('private-path fixture-secret provider-diagnostics'),
    );
    await expect(renderer.forcePollCloudMonitor()).rejects.toMatchObject({
      message: 'Cloud monitor operation failed',
      data: { monitorCode: 'monitor-operation-failed' },
    });
    await expect(
      renderer.setAutoSwitchModelsConfig({
        model: { enabled: true, priority: true, token: 'fixture-secret' },
      } as never),
    ).rejects.toThrow();
    await expect(
      renderer.setWeeklyWarmupConfig({ enabled: true, groups: ['invalid'] } as never),
    ).rejects.toThrow();
    await expect(
      renderer.setAutoSwitchModelsConfig(
        Object.fromEntries(
          Array.from({ length: 80 }, (_, i) => [`model-${i}`, { enabled: true, priority: true }]),
        ),
      ),
    ).rejects.toThrow();
  });
});

it('remote force poll writes quota/status only through the core owner and schedules warmup once', async () => {
  await remote();
  const value = account('current', 70);
  const quota = { models: { 'claude-sonnet': { percentage: 60, resetTime: '' } } };
  vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([value]);
  vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValue(quota);
  const warmup = vi.spyOn(cloudAccountWeeklyWarmupRunner, 'run').mockResolvedValue();
  expect(await renderer.forcePollCloudMonitor()).toBeUndefined();
  expect(CloudAccountRepo.updateQuota).toHaveBeenCalledExactlyOnceWith('current', quota);
  expect(CloudAccountRepo.setAccountStatus).toHaveBeenCalledExactlyOnceWith(
    'current',
    'active',
    null,
  );
  expect(warmup).toHaveBeenCalledExactlyOnceWith([
    expect.objectContaining({ id: 'current', quota }),
  ]);
});

it('auto-switch executes the Node owner policy for the requested target', async () => {
  settings.set('auto_switch_enabled', true);
  vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([
    account('current', 0),
    account('next', 90),
  ]);
  expect(await AutoSwitchService.checkAndSwitchIfNeeded('agy')).toBe(true);
  expect(switchCloudAccountCore).toHaveBeenCalledExactlyOnceWith('next', 'agy');
});

it('publishes only bounded owner hints after quota persistence', async () => {
  await remote();
  configureCoreOwnerPresentation();
  settings.set('quota_alert_enabled', true);
  settings.set('ai_credits_alert_enabled', true);
  const before = accountOwnerEvents.read(undefined, 0);
  vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([account('current', 5)]);
  vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValue({
    models: { 'claude-sonnet': { percentage: 5, resetTime: '' } },
    ai_credits: { credits: 10, expiryDate: '' },
  });
  await renderer.forcePollCloudMonitor();
  const batch = accountOwnerEvents.read(before.epoch, before.latest);
  expect(batch.events.map((item) => item.event)).toEqual([
    { kind: 'low-quota', accountId: 'current', language: 'en', models: ['claude-sonnet'] },
    { kind: 'low-ai-credit', accountId: 'current', language: 'en', credits: 10 },
  ]);
  expect(CloudAccountRepo.updateQuota).toHaveBeenCalledOnce();
  expect(JSON.stringify(batch)).not.toMatch(
    /fixture-secret|fixture-refresh|proxy_url|access_token|expiryDate/,
  );
});

it('does not interrupt owner persistence or warmup when a desktop effect throws', async () => {
  CloudMonitorService.configureEffects({
    onQuotaUpdated: () => {
      throw new Error('Notification failed');
    },
  });
  vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([account('current', 50)]);
  vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValue({ models: {} });
  const warmup = vi.spyOn(cloudAccountWeeklyWarmupRunner, 'run').mockResolvedValue();
  await expect(renderer.forcePollCloudMonitor()).resolves.toBeUndefined();
  expect(CloudAccountRepo.updateQuota).toHaveBeenCalledOnce();
  expect(warmup).toHaveBeenCalledOnce();
});

it('drains an admitted poll and blocks further polling before ownership release', async () => {
  const operations = await remote();
  let finish: (values: CloudAccount[]) => void = () => {};
  let entered: () => void = () => {};
  const admission = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.mocked(CloudAccountRepo.getAccounts).mockImplementationOnce(() => {
    entered();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const poll = renderer.forcePollCloudMonitor();
  await admission;
  let released = false;
  const shutdown = createCoreShutdown({
    management: { close: async () => {} },
    accountMutations: operations,
    monitor: CloudMonitorService,
    core: { stop: async () => {} },
    lease: {
      close: async () => {
        released = true;
      },
    },
  });
  const closing = shutdown();
  await Promise.resolve();
  expect(released).toBe(false);
  await expect(renderer.forcePollCloudMonitor()).rejects.toMatchObject({
    data: { monitorCode: 'monitor-operation-failed' },
  });
  await expect(CloudMonitorService.poll()).rejects.toThrow('shutting down');
  expect(CloudAccountRepo.getAccounts).toHaveBeenCalledOnce();
  finish([]);
  await poll;
  await closing;
  expect(released).toBe(true);
});

it('Node monitor policy has no Electron or desktop switch dependency', async () => {
  for (const file of [
    'CloudMonitorService.ts',
    'AutoSwitchService.ts',
    'cloud-account-monitor-control.service.ts',
  ]) {
    const source = await fs.readFile(path.join('src/modules/cloud-account/services', file), 'utf8');
    expect(source).not.toMatch(/from ['"]electron|cloud-account-switch-desktop|new Notification/);
  }
});
