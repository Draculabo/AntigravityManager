import { z } from 'zod';

const preferenceSchema = z.strictObject({
  window: z.enum(['1h', '24h']),
  modelView: z.enum(['requested', 'actual']),
  accountId: z.string().max(256),
  model: z.string().max(256),
});

export type UsageTrendsPreference = z.infer<typeof preferenceSchema>;

const defaults: UsageTrendsPreference = {
  window: '1h',
  modelView: 'requested',
  accountId: '',
  model: '',
};
const key = 'traffic_usage_trends_v1';

export function readUsageTrendsPreference(): UsageTrendsPreference {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = preferenceSchema.safeParse(raw === null ? null : JSON.parse(raw));
    return parsed.success ? parsed.data : defaults;
  } catch {
    return defaults;
  }
}

export function saveUsageTrendsPreference(value: UsageTrendsPreference): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
