import { z } from 'zod';

export const CloudAccountAlertPolicySchema = z.strictObject({
  quota_alert_enabled: z.boolean(),
  quota_alert_threshold: z.number().finite().min(0).max(100),
  ai_credits_alert_enabled: z.boolean(),
  ai_credits_alert_threshold: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const CloudAccountAlertPolicyUpdateSchema = CloudAccountAlertPolicySchema.partial();
export type CloudAccountAlertPolicy = z.infer<typeof CloudAccountAlertPolicySchema>;
export type CloudAccountAlertPolicyUpdate = z.infer<typeof CloudAccountAlertPolicyUpdateSchema>;
export const DEFAULT_CLOUD_ACCOUNT_ALERT_POLICY: CloudAccountAlertPolicy = {
  quota_alert_enabled: false,
  quota_alert_threshold: 20,
  ai_credits_alert_enabled: false,
  ai_credits_alert_threshold: 5000,
};
