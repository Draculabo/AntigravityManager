import { ORPCError } from '@orpc/server';

export function toCloudAccountSwitchStatusError(): ORPCError<
  string,
  { diagnosticsCode: 'unavailable' }
> {
  return new ORPCError('INTERNAL_SERVER_ERROR', {
    message: 'Account switch diagnostics are unavailable.',
    data: { diagnosticsCode: 'unavailable' },
  });
}
