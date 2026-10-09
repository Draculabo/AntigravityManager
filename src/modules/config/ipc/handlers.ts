import { desktopPreferencesStore } from './desktop-preferences';
import type { DesktopPreferences, DesktopPreferencesUpdate } from '../service-config.schema';
import { syncAutoStart } from '@/modules/antigravity-runtime/utils/autoStart';
import { setErrorReportingEnabled } from '@/shared/observability/errorReporting';
import { getConfigAdapter } from './config-adapter';

export const loadDesktopPreferences = () => desktopPreferencesStore.load();
let preferenceEffects: Promise<void> = Promise.resolve();

export function saveDesktopPreferences(
  preferences: DesktopPreferencesUpdate,
): Promise<DesktopPreferences> {
  const task = preferenceEffects.then(() => saveAndApplyDesktopPreferences(preferences));
  preferenceEffects = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

async function saveAndApplyDesktopPreferences(
  preferences: DesktopPreferencesUpdate,
): Promise<DesktopPreferences> {
  const previous = await desktopPreferencesStore.load();
  const saved = await desktopPreferencesStore.save(preferences);
  if (preferences.error_reporting_enabled !== undefined) {
    setErrorReportingEnabled(saved.error_reporting_enabled);
    await getConfigAdapter().errorReporting.setEnabled(saved.error_reporting_enabled);
  }
  if (previous.auto_startup !== saved.auto_startup) {
    syncAutoStart(saved);
  }
  return saved;
}
