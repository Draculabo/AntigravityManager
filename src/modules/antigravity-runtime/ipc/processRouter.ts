import { os } from '@orpc/server';
import { z } from 'zod';
import { AntigravityAppTargetSchema } from '@/shared/platform/antigravityAppTarget';
import { closeAntigravity, isProcessRunning, startAntigravity } from './handler';
import { getProcessOperation } from '../operation';
import { ProcessOperationSchema } from '../types';

const ProcessTargetInputSchema = z
  .object({ target: AntigravityAppTargetSchema.optional() })
  .optional();

export const processRouter = os.router({
  getOperation: os
    .input(ProcessTargetInputSchema)
    .output(ProcessOperationSchema)
    .handler(({ input }) => getProcessOperation(input?.target)),
  isProcessRunning: os
    .input(ProcessTargetInputSchema)
    .output(z.boolean())
    .handler(async ({ input }) => {
      return await isProcessRunning(input?.target);
    }),
  closeAntigravity: os
    .input(ProcessTargetInputSchema)
    .output(z.void())
    .handler(async ({ input }) => {
      await closeAntigravity(input?.target);
    }),
  startAntigravity: os
    .input(ProcessTargetInputSchema)
    .output(z.void())
    .handler(async ({ input }) => {
      await startAntigravity(input?.target);
    }),
});
