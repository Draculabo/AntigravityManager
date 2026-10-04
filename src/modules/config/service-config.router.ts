import { os, ORPCError } from '@orpc/server';
import { z } from 'zod';
import {
  ServiceConfigSnapshotSchema,
  ServiceConfigUpdateSchema,
  ServiceSecretNameSchema,
  ServiceSecretWriteSchema,
  ServiceSecretRevealSchema,
  ServiceConfigWriteResultSchema,
} from './service-config.schema';
import type { ServiceConfigOperations } from './service-config.service';
import {
  CloudAccountAlertPolicySchema,
  CloudAccountAlertPolicyUpdateSchema,
} from '@/modules/cloud-account/services/cloud-account-alert-policy.schema';
import type { CloudAccountAlertPolicyOperations } from '@/modules/cloud-account/services/cloud-account-alert-policy.service';

export function configurationUnavailable() {
  return new ORPCError('SERVICE_UNAVAILABLE', {
    message: 'Settings are unavailable right now. Please try again.',
    data: { configCode: 'unavailable' },
  });
}

/** Discard provider, filesystem and schema diagnostic values before crossing transport. */
async function safe<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch {
    throw configurationUnavailable();
  }
}

export function createServiceConfigRouter(service: ServiceConfigOperations) {
  return os.router({
    read: os.output(ServiceConfigSnapshotSchema).handler(() => safe(() => service.read())),
    update: os
      .input(ServiceConfigUpdateSchema)
      .output(ServiceConfigWriteResultSchema)
      .handler(({ input }) => safe(() => service.update(input))),
    writeSecret: os
      .input(ServiceSecretWriteSchema)
      .output(ServiceConfigWriteResultSchema)
      .handler(({ input }) => safe(() => service.writeSecret(input))),
    revealSecret: os
      .input(z.strictObject({ name: ServiceSecretNameSchema }))
      .output(ServiceSecretRevealSchema)
      .handler(({ input }) => safe(() => service.revealSecret(input.name))),
    generateKey: os
      .output(ServiceConfigWriteResultSchema)
      .handler(() => safe(() => service.generateKey())),
  });
}
export function createAccountAlertPolicyRouter(
  accountAlertPolicy: CloudAccountAlertPolicyOperations,
) {
  return os.router({
    read: os
      .output(CloudAccountAlertPolicySchema)
      .handler(() => safe(() => accountAlertPolicy.read())),
    update: os
      .input(CloudAccountAlertPolicyUpdateSchema)
      .output(CloudAccountAlertPolicySchema)
      .handler(({ input }) => safe(() => accountAlertPolicy.update(input))),
  });
}
