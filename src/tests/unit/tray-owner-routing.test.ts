import { BrowserWindow } from 'electron';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { initTray, destroyTray, updateTrayMenu } from '@/modules/app-shell/ipc/tray/handler';
import { getTrayTexts } from '@/modules/app-shell/ipc/tray/i18n';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';

const state = vi.hoisted(() => ({
  menu: [] as Array<{ label?: string; click?: () => Promise<void> | void }>,
  listViews: vi.fn(),
  switchAccount: vi.fn(),
  refreshQuota: vi.fn(),
  localReads: vi.fn(),
  localActive: vi.fn(),
  send: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  BrowserWindow: class {
    webContents = { send: state.send };
  },
  Tray: class {
    setToolTip() {}
    on() {}
    setContextMenu() {}
    destroy() {}
  },
  Menu: {
    buildFromTemplate: (menu: typeof state.menu) => {
      state.menu = menu;
      return {};
    },
  },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
}));
vi.mock('@/modules/app-shell/ipc/tray/icon', () => ({
  configureTrayIcon: vi.fn(),
  resolveTrayIconPath: () => '/fixture/icon.png',
}));
vi.mock('@/modules/cloud-account/ipc/cloud-account-adapter', () => ({
  getCloudAccountAdapter: () => ({
    listViews: state.listViews,
    switchAccount: state.switchAccount,
    refreshQuota: state.refreshQuota,
  }),
}));
vi.mock('@/modules/cloud-account/persistence/cloudHandler', () => ({
  CloudAccountRepo: { getAccounts: state.localReads, setActive: state.localActive },
}));

const current: CloudAccountView = {
  id: 'current',
  provider: 'google',
  email: 'current@example.com',
  created_at: 1,
  last_used: 1,
  is_active: true,
  proxy_configured: false,
};
const next: CloudAccountView = {
  ...current,
  id: 'next',
  email: 'next@example.com',
  is_active: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  state.listViews.mockResolvedValue([current, next]);
  initTray(new BrowserWindow());
});
afterEach(() => {
  destroyTray();
});
async function click(label: string) {
  const action = state.menu.find((item) => item.label === label)?.click;
  if (!action) {
    throw new Error('Tray action missing');
  }
  await action();
}
describe('tray selected owner routing', () => {
  it('switches through the selected owner without local repository writes', async () => {
    updateTrayMenu(current);
    await click(getTrayTexts('en').switch_next);
    expect(state.switchAccount).toHaveBeenCalledExactlyOnceWith('next');
    expect(state.send).toHaveBeenCalledExactlyOnceWith('tray://account-switched', 'next');
    expect(state.localReads).not.toHaveBeenCalled();
    expect(state.localActive).not.toHaveBeenCalled();
  });
  it('refreshes through the selected owner and presents the returned safe view', async () => {
    const refreshed = {
      ...current,
      quota: { models: { 'claude-sonnet': { percentage: 60, resetTime: '' } } },
    };
    state.refreshQuota.mockResolvedValue(refreshed);
    await click(getTrayTexts('en').refresh_current);
    expect(state.refreshQuota).toHaveBeenCalledExactlyOnceWith('current');
    expect(state.menu.map((item) => item.label)).toContain('Claude 4.5: 60%');
    expect(state.localReads).not.toHaveBeenCalled();
  });
});
