import { os, ORPCError } from '@orpc/server';
import { app } from 'electron';
import path from 'node:path';
import { z } from 'zod';
import {
  CoworkDiscoveryInput, CoworkLifecycleInput, CoworkLifecycleResultSchema,
  CoworkOperationError, CoworkOperationInput, CoworkPreviewSchema,
  CoworkReceiptSchema, CoworkSelectionInput, CoworkTargetSchema,
} from '../cowork/contracts';
import { CoworkRuntimeService } from '../cowork/service';

let service: CoworkRuntimeService | null = null;
function owner(): CoworkRuntimeService {
  service ??= new CoworkRuntimeService({
    backupRoot: path.join(app.getPath('userData'), 'cowork-runtime-recovery'),
  });
  return service;
}

async function readOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new ORPCError('PRECONDITION_FAILED', {
      message: cause instanceof CoworkOperationError ? cause.code : 'Cowork inspection is unavailable.',
    });
  }
}

export const coworkRuntimeRouter = os.router({
  discover: os.input(CoworkDiscoveryInput).output(z.array(CoworkTargetSchema))
    .handler(({ input }) => readOperation(() => owner().discover(input.customPath))),
  inspect: os.input(CoworkSelectionInput).output(CoworkTargetSchema)
    .handler(({ input }) => readOperation(() => owner().inspect(input.selectionId))),
  preview: os.input(CoworkSelectionInput.extend({ action: z.enum(['apply', 'restore']) }))
    .output(CoworkPreviewSchema)
    .handler(({ input }) => readOperation(() => owner().preview(input.selectionId, input.action))),
  apply: os.input(CoworkOperationInput).output(CoworkReceiptSchema)
    .handler(({ input }) => owner().operate(input, 'apply')),
  restore: os.input(CoworkOperationInput).output(CoworkReceiptSchema)
    .handler(({ input }) => owner().operate(input, 'restore')),
  lifecycle: os.input(CoworkLifecycleInput).output(CoworkLifecycleResultSchema)
    .handler(({ input }) => readOperation(() => owner().lifecycle(input.selectionId, input.action))),
});
