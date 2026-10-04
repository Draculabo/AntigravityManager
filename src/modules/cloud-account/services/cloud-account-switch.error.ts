import { ORPCError } from '@orpc/server';
import {
  readCloudAccountSwitchErrorCode,
  type CloudAccountSwitchErrorCode,
} from './cloud-account-switch.schema';

export class CloudAccountSwitchError extends Error {
  constructor(readonly switchCode: CloudAccountSwitchErrorCode) {
    super('Cloud account switch failed');
    this.name = 'CloudAccountSwitchError';
  }
}

export function toCloudAccountSwitchORPCError(error: unknown) {
  const switchCode =
    readCloudAccountSwitchErrorCode(error) ??
    (error instanceof CloudAccountSwitchError ? error.switchCode : 'switch-failed');
  return new ORPCError(switchCode === 'switch-failed' ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST', {
    message: 'Cloud account switch failed',
    data: { switchCode },
  });
}
