import { ORPCError } from '@orpc/server';

export function toCloudMonitorORPCError() {
  return new ORPCError('INTERNAL_SERVER_ERROR', {
    message: 'Cloud monitor operation failed',
    data: { monitorCode: 'monitor-operation-failed' },
  });
}
