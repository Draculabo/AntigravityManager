import { CloudAccountSettingsStore } from '../persistence/cloud-account-settings-store';
import {
  CloudAccountAlertPolicySchema,
  CloudAccountAlertPolicyUpdateSchema,
  DEFAULT_CLOUD_ACCOUNT_ALERT_POLICY,
  type CloudAccountAlertPolicy,
  type CloudAccountAlertPolicyUpdate,
} from './cloud-account-alert-policy.schema';

export interface CloudAccountAlertPolicyOperations {
  read(): Promise<CloudAccountAlertPolicy>;
  update(input: CloudAccountAlertPolicyUpdate): Promise<CloudAccountAlertPolicy>;
}
let accepting = true;
function read(): CloudAccountAlertPolicy {
  const defaults = DEFAULT_CLOUD_ACCOUNT_ALERT_POLICY;
  return {
    quota_alert_enabled: CloudAccountSettingsStore.getSetting(
      'quota_alert_enabled',
      defaults.quota_alert_enabled,
      CloudAccountAlertPolicySchema.shape.quota_alert_enabled,
    ),
    quota_alert_threshold: CloudAccountSettingsStore.getSetting(
      'quota_alert_threshold',
      defaults.quota_alert_threshold,
      CloudAccountAlertPolicySchema.shape.quota_alert_threshold,
    ),
    ai_credits_alert_enabled: CloudAccountSettingsStore.getSetting(
      'ai_credits_alert_enabled',
      defaults.ai_credits_alert_enabled,
      CloudAccountAlertPolicySchema.shape.ai_credits_alert_enabled,
    ),
    ai_credits_alert_threshold: CloudAccountSettingsStore.getSetting(
      'ai_credits_alert_threshold',
      defaults.ai_credits_alert_threshold,
      CloudAccountAlertPolicySchema.shape.ai_credits_alert_threshold,
    ),
  };
}

/** Existing SQLite settings remain authoritative; legacy GUI copies are never promoted or mirrored. */
export const cloudAccountAlertPolicy: CloudAccountAlertPolicyOperations & {
  closeAdmission(): void;
} = {
  closeAdmission: () => {
    accepting = false;
  },
  read: async () => read(),
  update: async (input) => {
    if (!accepting) {
      throw new Error('Alert policy owner is shutting down.');
    }
    const accepted = CloudAccountAlertPolicyUpdateSchema.parse(input);
    CloudAccountSettingsStore.setAlertPolicy(accepted);
    return read();
  },
};
