import { describe, expect, it, vi } from 'vitest';
import { DesktopPreferencesSchema } from '@/modules/config/service-config.schema';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';

const effects = vi.hoisted(() => ({
  setEnabled: vi.fn<(enabled: boolean) => Promise<void>>(),
  local: vi.fn(),
  trayLanguage: vi.fn(),
  beforeSave: vi.fn(),
}));
vi.mock('@/modules/app-shell/ipc/tray/handler', () => ({ setTrayLanguage: effects.trayLanguage }));
vi.mock('@/shared/observability/errorReporting', () => ({
  setErrorReportingEnabled: effects.local,
}));
vi.mock('@/modules/config/ipc/config-adapter', () => ({
  getConfigAdapter: () => ({ errorReporting: { setEnabled: effects.setEnabled } }),
}));
vi.mock('@/modules/antigravity-runtime/utils/autoStart', () => ({ syncAutoStart: vi.fn() }));
vi.mock('@/modules/config/ipc/desktop-preferences', async () => {
  const { DesktopPreferencesSchema } = await import('@/modules/config/service-config.schema');
  const { DEFAULT_APP_CONFIG } = await import('@/modules/config/types');
  let current = DesktopPreferencesSchema.strip().parse(DEFAULT_APP_CONFIG);
  return {
    desktopPreferencesStore: {
      load: async () => current,
      save: async (update: { error_reporting_enabled?: boolean; language?: string }) => {
        effects.beforeSave();
        current = { ...current, ...update };
        return current;
      },
    },
  };
});

describe('desktop error reporting preference propagation', () => {
  it('does not add a core reporting RPC to unrelated preference saves', async () => {
    effects.setEnabled.mockClear();
    effects.local.mockClear();
    const { saveDesktopPreferences } = await import('@/modules/config/ipc/handlers');
    await saveDesktopPreferences({ auto_startup: false });
    expect(effects.setEnabled).not.toHaveBeenCalled();
    expect(effects.local).not.toHaveBeenCalled();
  });
  it('serializes saved preferences and owner effects across concurrent changes', async () => {
    effects.setEnabled.mockClear();
    effects.local.mockClear();
    const { saveDesktopPreferences } = await import('@/modules/config/ipc/handlers');
    let release: () => void = () => undefined;
    effects.setEnabled
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const disabled = saveDesktopPreferences({ error_reporting_enabled: false });
    const enabled = saveDesktopPreferences({ error_reporting_enabled: true });
    await vi.waitFor(() => expect(effects.setEnabled).toHaveBeenCalledExactlyOnceWith(false));
    release();
    expect(await disabled).toEqual({
      ...DesktopPreferencesSchema.strip().parse(DEFAULT_APP_CONFIG),
      auto_startup: false,
      error_reporting_enabled: false,
    });
    expect((await enabled).error_reporting_enabled).toBe(true);
    expect(effects.setEnabled.mock.calls).toEqual([[false], [true]]);
    expect(effects.local.mock.calls).toEqual([[false], [true]]);
  });

  it('updates the tray only after the language preference is saved', async () => {
    const { saveDesktopPreferences } = await import('@/modules/config/ipc/handlers');
    effects.beforeSave.mockImplementationOnce(() => {
      throw new Error('Disk write failed');
    });
    await expect(saveDesktopPreferences({ language: 'fr' })).rejects.toThrow('Disk write failed');
    expect(effects.trayLanguage).not.toHaveBeenCalled();
    await saveDesktopPreferences({ language: 'fr' });
    expect(effects.trayLanguage).toHaveBeenCalledExactlyOnceWith('fr');
  });
});
