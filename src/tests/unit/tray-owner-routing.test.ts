import { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  destroyTray,
  initTray,
  isTrayReady,
  refreshTrayAccount,
} from '@/modules/app-shell/ipc/tray/handler';
import { getTrayTexts } from '@/modules/app-shell/ipc/tray/i18n';
import { restoreHiddenStartupWindow } from '@/modules/app-shell/utils/windowActivation';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';

type TrayMenu = Array<{ label?: string; click?: () => Promise<void> | void }>;

const state = vi.hoisted(() => ({
  menu: { items: new Array<TrayMenu[number]>() },
  adapter: {
    listViews: vi.fn<() => Promise<CloudAccountView[]>>(),
    switchAccount: vi.fn(),
    refreshQuota: vi.fn(),
  },
  localReads: vi.fn(),
  localActive: vi.fn(),
  constructTray: vi.fn(),
  destroyTray: vi.fn(),
  installMenu: vi.fn(),
  registerEvent: vi.fn(),
  window: {
    isDestroyed: vi.fn(),
    isVisible: vi.fn(),
    isMinimized: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    restore: vi.fn(),
    focus: vi.fn(),
  },
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  BrowserWindow: class {
    isDestroyed = state.window.isDestroyed;
    isVisible = state.window.isVisible;
    isMinimized = state.window.isMinimized;
    show = state.window.show;
    hide = state.window.hide;
    restore = state.window.restore;
    focus = state.window.focus;
    webContents = { send: state.send };
  },
  Tray: class {
    constructor() {
      state.constructTray();
    }
    setToolTip() {}
    on = state.registerEvent;
    setContextMenu = state.installMenu;
    destroy = state.destroyTray;
  },
  Menu: {
    buildFromTemplate: (menu: TrayMenu) => menu,
  },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
}));
vi.mock('@/modules/app-shell/ipc/tray/icon', () => ({
  configureTrayIcon: vi.fn(),
  resolveTrayIconPath: () => '/fixture/icon.png',
}));
vi.mock('@/modules/cloud-account/ipc/cloud-account-adapter', () => ({
  getCloudAccountAdapter: () => state.adapter,
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
  is_active_classic: true,
  proxy_configured: false,
};
const ideOnly: CloudAccountView = {
  ...current,
  id: 'ide',
  email: 'ide@example.com',
  is_active_classic: false,
  is_active_ide: true,
};
const next: CloudAccountView = {
  ...current,
  id: 'next',
  email: 'next@example.com',
  is_active_classic: false,
  is_active_agy: true,
};
const texts = getTrayTexts('en');

beforeEach(() => {
  vi.resetAllMocks();
  state.menu.items = [];
  state.installMenu.mockImplementation((menu: TrayMenu) => {
    state.menu.items = menu;
  });
  state.adapter.listViews.mockResolvedValue([ideOnly, current, next]);
  state.window.isDestroyed.mockReturnValue(false);
  state.window.isVisible.mockReturnValue(false);
  state.window.isMinimized.mockReturnValue(false);
});
afterEach(() => {
  destroyTray();
});

async function click(label: string) {
  const action = state.menu.items.find((item) => item.label === label)?.click;
  if (!action) {
    throw new Error('Tray action missing');
  }
  await action();
}

function labels() {
  return state.menu.items.map((item) => item.label);
}

describe('tray selected owner routing', () => {
  it('loads current Classic on startup and switches to the following account on Classic', async () => {
    expect(initTray(new BrowserWindow())).toBe(true);
    await Promise.resolve();
    expect(labels()[0]).toBe(`${texts.current}: ${current.email}`);
    state.adapter.switchAccount.mockImplementation(async () => {
      state.adapter.listViews.mockResolvedValue([
        ideOnly,
        { ...current, is_active_classic: false },
        { ...next, is_active_classic: true },
      ]);
    });
    await click(texts.switch_next);
    expect(state.adapter.switchAccount).toHaveBeenCalledExactlyOnceWith(next.id, 'classic');
    expect(state.send).toHaveBeenCalledExactlyOnceWith('tray://account-switched', next.id);
    expect(labels()[0]).toBe(`${texts.current}: ${next.email}`);
    expect(state.localReads).not.toHaveBeenCalled();
    expect(state.localActive).not.toHaveBeenCalled();
  });

  it('refreshes the current Classic even when other targets are active', async () => {
    initTray(new BrowserWindow());
    await click(texts.refresh_current);
    expect(state.adapter.refreshQuota).toHaveBeenCalledExactlyOnceWith(current.id);
    expect(state.send).toHaveBeenCalledExactlyOnceWith('tray://refresh-current');
    expect(state.localReads).not.toHaveBeenCalled();
  });

  it('shows no account and skips refresh if only IDE and AGY are active', async () => {
    state.adapter.listViews.mockResolvedValue([ideOnly, next]);
    initTray(new BrowserWindow());
    await click(texts.refresh_current);
    expect(labels()[0]).toBe(`${texts.current}: ${texts.no_account}`);
    expect(state.adapter.refreshQuota).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
    await click(texts.switch_next);
    expect(state.adapter.switchAccount).toHaveBeenCalledExactlyOnceWith(ideOnly.id, 'classic');
  });

  it('keeps Classic current when reconciliation follows an unrelated quota refresh', async () => {
    initTray(new BrowserWindow());
    state.adapter.listViews.mockResolvedValue([
      { ...ideOnly, quota: { models: { 'claude-sonnet-4-6': { percentage: 90, resetTime: '' } } } },
      { ...current, quota: { models: { 'claude-sonnet-4-6': { percentage: 60, resetTime: '' } } } },
      next,
    ]);
    await refreshTrayAccount();
    expect(labels()[0]).toBe(`${texts.current}: ${current.email}`);
    expect(labels()).toContain('Claude: 60%');
    expect(labels()).not.toContain('Claude: 90%');
  });

  it('ignores an older read that finishes after newer Classic state is presented', async () => {
    const old = Promise.withResolvers<CloudAccountView[]>();
    state.adapter.listViews.mockReturnValueOnce(old.promise);
    initTray(new BrowserWindow());
    state.adapter.listViews.mockResolvedValue([ideOnly, { ...next, is_active_classic: true }]);
    await refreshTrayAccount();
    old.resolve([ideOnly, current, next]);
    await old.promise;
    expect(labels()[0]).toBe(`${texts.current}: ${next.email}`);
  });

  it('ignores a pending read after the tray is destroyed', async () => {
    const old = Promise.withResolvers<CloudAccountView[]>();
    state.adapter.listViews.mockReturnValueOnce(old.promise);
    initTray(new BrowserWindow());
    destroyTray();
    old.resolve([current]);
    await old.promise;
    expect(state.installMenu).toHaveBeenCalledOnce();
    expect(isTrayReady()).toBe(false);
  });
});

describe('tray window lifecycle', () => {
  it('restores a minimized window by double-click or Show Window and still toggles a visible window', async () => {
    initTray(new BrowserWindow());
    const doubleClick = state.registerEvent.mock.calls[0][1];
    expect(state.registerEvent).toHaveBeenCalledExactlyOnceWith('double-click', doubleClick);

    state.window.isVisible.mockReturnValue(true);
    state.window.isMinimized.mockReturnValue(true);
    doubleClick();
    await click(texts.show_window);
    expect(state.window.restore).toHaveBeenCalledTimes(2);
    expect(state.window.focus).toHaveBeenCalledTimes(2);
    expect(state.window.hide).not.toHaveBeenCalled();

    state.window.isMinimized.mockReturnValue(false);
    doubleClick();
    expect(state.window.hide).toHaveBeenCalledOnce();

    state.window.isDestroyed.mockReturnValue(true);
    doubleClick();
    await click(texts.show_window);
    expect(state.window.hide).toHaveBeenCalledOnce();
    expect(state.window.focus).toHaveBeenCalledTimes(2);
  });

  it('reports Tray constructor failure so hidden startup can restore the window', () => {
    state.constructTray.mockImplementationOnce(() => {
      throw new Error('Tray is unavailable');
    });
    const window = new BrowserWindow();
    const ready = initTray(window);
    expect(ready).toBe(false);
    expect(isTrayReady()).toBe(false);
    expect(state.adapter.listViews).not.toHaveBeenCalled();
    restoreHiddenStartupWindow(window, ready);
    expect(state.window.show).toHaveBeenCalledOnce();
    expect(state.window.focus).toHaveBeenCalledOnce();
  });

  it('disposes a partial tray when installing the menu throws', () => {
    state.installMenu.mockImplementationOnce(() => {
      throw new Error('Tray menu is unavailable');
    });
    expect(initTray(new BrowserWindow())).toBe(false);
    expect(state.destroyTray).toHaveBeenCalledOnce();
    expect(isTrayReady()).toBe(false);
    expect(state.adapter.listViews).not.toHaveBeenCalled();
  });
});
