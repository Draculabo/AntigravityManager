import { desktopPreferencesStore } from './desktop-preferences';
import type { DesktopPreferences, DesktopPreferencesUpdate } from '../service-config.schema';
import { syncAutoStart } from '@/modules/antigravity-runtime/utils/autoStart';
import { logger } from '@/shared/logging/logger';

export const loadDesktopPreferences = () => desktopPreferencesStore.load();

export async function saveDesktopPreferences(
  preferences: DesktopPreferencesUpdate,
): Promise<DesktopPreferences> {
  const previous = await desktopPreferencesStore.load();
  const saved = await desktopPreferencesStore.save(preferences);
  logger.setErrorReportingEnabled(saved.error_reporting_enabled);
  if (previous.auto_startup !== saved.auto_startup) {
    syncAutoStart(saved);
  }
  return saved;
}
