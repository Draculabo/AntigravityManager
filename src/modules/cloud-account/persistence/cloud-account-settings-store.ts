import { eq } from 'drizzle-orm';
import {
  type AntigravityAppTarget,
  resolveAntigravityAppTarget,
} from '@/shared/platform/antigravityAppTarget';
import { logger } from '@/shared/logging/logger';
import { settings } from '@/shared/persistence/database/schema';
import { getCloudDb } from './cloud-account-db';

const ACTIVE_ACCOUNT_SETTING_PREFIX = 'active_cloud_account';

export class CloudAccountSettingsStore {
  static getSetting<T>(key: string, defaultValue: T): T {
    const { raw, orm } = getCloudDb();
    try {
      const rows = orm
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, key))
        .all();
      const row = rows[0];
      if (!row) {
        return defaultValue;
      }
      return JSON.parse(row.value) as T;
    } catch (error) {
      logger.error(`Failed to get setting ${key}`, error);
      return defaultValue;
    } finally {
      raw.close();
    }
  }

  static setSetting(key: string, value: unknown): void {
    const { raw, orm } = getCloudDb();
    try {
      const stringValue = JSON.stringify(value);
      orm
        .insert(settings)
        .values({ key, value: stringValue })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: stringValue },
        })
        .run();
    } finally {
      raw.close();
    }
  }

  static setActiveForTarget(target: AntigravityAppTarget | undefined, id: string): void {
    const normalizedTarget = resolveAntigravityAppTarget(target);
    this.setSetting(`${ACTIVE_ACCOUNT_SETTING_PREFIX}.${normalizedTarget}`, id);
  }

  static getActiveAccountIdForTarget(target: AntigravityAppTarget | undefined): string {
    const normalizedTarget = resolveAntigravityAppTarget(target);
    return this.getSetting(`${ACTIVE_ACCOUNT_SETTING_PREFIX}.${normalizedTarget}`, '');
  }
}
