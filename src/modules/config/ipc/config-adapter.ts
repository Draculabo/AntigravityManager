import type { CoreRpcClient } from '@/core/rpc/client';
import { errorProcessOwner } from '@/modules/error-diagnostics/public';
import { logger } from '@/shared/logging/logger';
import { randomUUID } from 'node:crypto';
import type { ServiceConfigWriteResult } from '../service-config.schema';
import { errorReportingService, type ErrorReportingOperations } from '../error-reporting.service';
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
  | 'setErrorReportingEnabled'
>;
interface ConfigAdapter extends ServiceConfigOperations {
  errorReporting: ErrorReportingOperations;
  accountAlertPolicy: CloudAccountAlertPolicyOperations;
}
let selected: ConfigAdapter = {
  errorReporting: errorReportingService,
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
      ? {
          ...serviceConfigService,
          accountAlertPolicy: cloudAccountAlertPolicy,
          errorReporting: errorReportingService,
        }
      : {
          errorReporting: {
            setEnabled: (enabled) => selection.client.setErrorReportingEnabled(enabled),
          },
          read: async () => {
            const snapshot = await selection.client.readServiceConfig();
            try {
              await errorProcessOwner.applyBudget(snapshot.errorDiagnosticsBudget);
            } catch {
              logger.warn('Selected error diagnostic allocation could not be applied to the app');
            }
            return snapshot;
          },
          update: (input) => applyAppBudget(selection.client.updateServiceConfig(input)),
          writeSecret: (input) => applyAppBudget(selection.client.writeServiceSecret(input)),
          revealSecret: (name) => selection.client.revealServiceSecret(name),
          generateKey: () => applyAppBudget(selection.client.generateServiceApiKey()),
          accountAlertPolicy: {
            read: () => selection.client.readAccountAlertPolicy(),
            update: (input) => selection.client.updateAccountAlertPolicy(input),
          },
        };
}

async function applyAppBudget(
  result: Promise<ServiceConfigWriteResult>,
): Promise<ServiceConfigWriteResult> {
  const saved = await result;
  try {
    await errorProcessOwner.applyBudget(saved.snapshot.errorDiagnosticsBudget);
    return saved;
  } catch (error) {
    const diagnosticId = randomUUID();
    logger.error('Settings were saved; the desktop diagnostic budget could not be applied.', { diagnosticId }, error);
    return {
      ...saved,
      state: 'partial-failure',
      issues: [
        ...(saved.issues ?? []),
        { step: 'error-diagnostics', fields: ['error_diagnostics'], reason: 'runtime-application-failed', diagnosticId },
      ],
    };
  }
}

export function getConfigAdapter(): ConfigAdapter {
  return selected;
}
