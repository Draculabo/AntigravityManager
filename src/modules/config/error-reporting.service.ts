import { os } from '@orpc/server';
import { z } from 'zod';
import { setErrorReportingEnabled } from '@/shared/observability/errorReporting';

export interface ErrorReportingOperations {
  setEnabled(enabled: boolean): void | Promise<void>;
}
export const errorReportingService: ErrorReportingOperations = {
  setEnabled: setErrorReportingEnabled,
};
export function createErrorReportingRouter(operations: ErrorReportingOperations) {
  return {
    setEnabled: os
      .input(z.strictObject({ enabled: z.boolean() }))
      .output(z.void())
      .handler(async ({ input }) => {
        await operations.setEnabled(input.enabled);
      }),
  };
}
