import type { CoreRpcClient } from '@/core/rpc/client';
import { serviceConfigService, type ServiceConfigOperations } from '../service-config.service';
import {
  cloudAccountAlertPolicy,
  type CloudAccountAlertPolicyOperations,
} from '@/modules/cloud-account/services/cloud-account-alert-policy.service';

type StandaloneCoreConfigClient = Pick<
  CoreRpcClient,
  | 'readServiceConfig'
  | 'updateServiceConfig'
  | 'writeServiceSecret'
  | 'revealServiceSecret'
  | 'generateServiceApiKey'
  | 'readAccountAlertPolicy'
  | 'updateAccountAlertPolicy'
>;
interface ConfigAdapter extends ServiceConfigOperations {
  accountAlertPolicy: CloudAccountAlertPolicyOperations;
}
let selected: ConfigAdapter = {
  ...serviceConfigService,
  accountAlertPolicy: cloudAccountAlertPolicy,
};

/** Must use the same startup selection as the account and gateway adapters. */
export function selectConfigAdapter(
  selection:
    | { mode: 'desktop-embedded' }
    | { mode: 'standalone-core'; client: StandaloneCoreConfigClient },
): void {
  selected =
    selection.mode === 'desktop-embedded'
      ? { ...serviceConfigService, accountAlertPolicy: cloudAccountAlertPolicy }
      : {
          read: () => selection.client.readServiceConfig(),
          update: (input) => selection.client.updateServiceConfig(input),
          writeSecret: (input) => selection.client.writeServiceSecret(input),
          revealSecret: (name) => selection.client.revealServiceSecret(name),
          generateKey: () => selection.client.generateServiceApiKey(),
          accountAlertPolicy: {
            read: () => selection.client.readAccountAlertPolicy(),
            update: (input) => selection.client.updateAccountAlertPolicy(input),
          },
        };
}

export function getConfigAdapter(): ConfigAdapter {
  return selected;
}
