import type { LoginItemSettingsOptions, Settings } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncAutoStart } from '@/modules/antigravity-runtime/utils/autoStart';

const { getLoginItemSettings, setLoginItemSettings, warn } = vi.hoisted(() => ({
  getLoginItemSettings: vi.fn<(options?: LoginItemSettingsOptions) => { openAtLogin: boolean }>(),
  setLoginItemSettings: vi.fn<(settings: Settings) => void>(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({ app: { getLoginItemSettings, setLoginItemSettings } }));
vi.mock('@/shared/logging/logger', () => ({
  logger: { warn, info: vi.fn(), error: vi.fn() },
}));

describe('Windows login item diagnostics', () => {
  let registered: Settings | undefined;

  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    registered = undefined;
    setLoginItemSettings.mockImplementation((settings) => {
      registered = settings.openAtLogin ? settings : undefined;
    });
    getLoginItemSettings.mockImplementation((options) => ({
      openAtLogin:
        registered !== undefined &&
        (options?.path ?? process.execPath) === registered.path &&
        (options?.args ?? []).join(' ') === registered.args?.join(' '),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('accepts a registered login item carrying the autostart flag', () => {
    syncAutoStart({ auto_startup: true });
    expect(registered?.args).toEqual(['--autostart']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts successful removal of the managed login item', () => {
    syncAutoStart({ auto_startup: true });
    warn.mockClear();

    syncAutoStart({ auto_startup: false });
    expect(registered).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when registration does not take effect', () => {
    setLoginItemSettings.mockImplementationOnce(() => undefined);
    syncAutoStart({ auto_startup: true });
    expect(warn).toHaveBeenCalledWith(
      'AutoStart: Login item mismatch (expected true, actual false)',
    );
  });

  it('warns when the autostart entry survives removal', () => {
    syncAutoStart({ auto_startup: true });
    warn.mockClear();
    setLoginItemSettings.mockImplementationOnce(() => undefined);

    syncAutoStart({ auto_startup: false });
    expect(warn).toHaveBeenCalledWith(
      'AutoStart: Login item mismatch (expected false, actual true)',
    );
  });
});
