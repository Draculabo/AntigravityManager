import { z } from 'zod';
import { CloudAccountSettingsStore } from '../persistence/cloud-account-settings-store';
import type { CloudAccount } from '../types';
import {
  OwnerNotificationModelSchema,
  type OwnerNotificationLanguage,
  type AccountOwnerEventDraft,
} from './account-owner-events.schema';

function notificationLanguage(language: string): OwnerNotificationLanguage {
  const normalized = language.toLowerCase();
  if (normalized.startsWith('zh')) {
    return 'zh-CN';
  }
  for (const value of ['ru', 'vi', 'fr', 'tr'] as const) {
    if (normalized.startsWith(value)) {
      return value;
    }
  }
  return 'en';
}

export function collectCloudMonitorAlerts(accounts: CloudAccount[]): AccountOwnerEventDraft[] {
  const language = notificationLanguage(
    CloudAccountSettingsStore.getSetting('language', 'en', z.string()),
  );
  const quotaEnabled = CloudAccountSettingsStore.getSetting(
    'quota_alert_enabled',
    false,
    z.boolean(),
  );
  const quotaThreshold = CloudAccountSettingsStore.getSetting(
    'quota_alert_threshold',
    20,
    z.number(),
  );
  const creditEnabled = CloudAccountSettingsStore.getSetting(
    'ai_credits_alert_enabled',
    false,
    z.boolean(),
  );
  const creditThreshold = CloudAccountSettingsStore.getSetting(
    'ai_credits_alert_threshold',
    5000,
    z.number(),
  );
  const alerts: AccountOwnerEventDraft[] = [];
  for (const account of accounts) {
    if (quotaEnabled && account.quota?.models) {
      const models = Object.entries(account.quota.models)
        .filter(
          ([model, info]) =>
            info.percentage >= 0 &&
            info.percentage <= quotaThreshold &&
            OwnerNotificationModelSchema.safeParse(model).success,
        )
        .map(([model]) => model)
        .slice(0, 16);
      if (models.length > 0) {
        alerts.push({ kind: 'low-quota', accountId: account.id, language, models });
      }
    }
    const credits = account.quota?.ai_credits?.credits;
    if (
      creditEnabled &&
      credits !== undefined &&
      Number.isFinite(credits) &&
      credits <= creditThreshold
    ) {
      alerts.push({
        kind: 'low-ai-credit',
        accountId: account.id,
        language,
        credits: Math.max(0, credits),
      });
    }
  }
  return alerts;
}
