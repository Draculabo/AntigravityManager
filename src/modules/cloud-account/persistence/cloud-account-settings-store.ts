import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  type AntigravityAppTarget,
  resolveAntigravityAppTarget,
} from '@/shared/platform/antigravityAppTarget';
import { logger } from '@/shared/logging/logger';
import { settings } from '@/shared/persistence/database/schema';
import { getCloudDb } from './cloud-account-db';
import type { CloudAccountAlertPolicyUpdate } from '../services/cloud-account-alert-policy.schema';

const ACTIVE_ACCOUNT_SETTING_PREFIX = 'active_cloud_account';
const StringSettingSchema = z.string();

export class CloudAccountSettingsStore {
  /** One SQLite transaction; no JSON configuration writes participate in this policy update. */
  static setAlertPolicy(input: CloudAccountAlertPolicyUpdate): void {
    const entries = Object.entries(input).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      return;
    }
    const { raw, orm } = getCloudDb();
    try {
      orm.transaction((transaction) => {
        for (const [key, value] of entries) {
          const encoded = JSON.stringify(value);
          transaction
            .insert(settings)
            .values({ key, value: encoded })
            .onConflictDoUpdate({ target: settings.key, set: { value: encoded } })
            .run();
        }
      });
    } finally {
      raw.close();
    }
  }
  /** Missing settings use the default; corrupt or unavailable storage must remain an error. */
  static readSetting(key: string): unknown {
    const { raw, orm } = getCloudDb();
    try {
      const row = orm
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, key))
        .get();
      if (!row) {
        return undefined;
      }
      const rawSetting: unknown = JSON.parse(row.value);
      return rawSetting;
    } finally {
      raw.close();
    }
  }

  static getSetting<T>(key: string, defaultValue: T, schema: z.ZodType<T>): T {
    const { raw, orm } = getCloudDb();
    try {
      const row = orm
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, key))
        .get();
      if (!row) {
        return defaultValue;
      }
      const rawSetting: unknown = JSON.parse(row.value);
      const parsed = schema.safeParse(rawSetting);
      if (!parsed.success) {
        logger.warn(`Ignored invalid setting ${key}; using default value`, parsed.error);
        return defaultValue;
      }
      return parsed.data;
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
    const key = `${ACTIVE_ACCOUNT_SETTING_PREFIX}.${normalizedTarget}`;
    const value = this.getSetting(key, '', StringSettingSchema);

    if (typeof value !== 'string') {
      logger.warn(`Ignored invalid active account setting ${key}: expected a string`);
      return '';
    }

    return value.trim();
  }
}
