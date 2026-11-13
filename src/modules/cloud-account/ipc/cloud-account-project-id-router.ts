import { ORPCError, os } from '@orpc/server';
import {
  AccountProjectIdResultSchema,
  FetchAccountProjectIdInputSchema,
  GetAccountProjectIdInputSchema,
  SetAccountProjectIdInputSchema,
  type AccountProjectIdErrorCode,
  type AccountProjectIdResult,
  type CloudAccountProjectIdOperations,
} from '../services/cloud-account-project-id.schema';
import { AccountProjectIdError } from '../services/cloud-account-project-id.service';

const transportCode = {
  'account-not-found': 'NOT_FOUND',
  'unsupported-account': 'BAD_REQUEST',
  'project-id-changed': 'CONFLICT',
  'project-id-unavailable': 'NOT_FOUND',
  'project-id-fetch-failed': 'BAD_GATEWAY',
} satisfies Record<AccountProjectIdErrorCode, string>;

async function execute(
  work: () => Promise<AccountProjectIdResult>,
): Promise<AccountProjectIdResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AccountProjectIdError) {
      throw new ORPCError(transportCode[error.projectIdCode], {
        message: error.message,
        data: { projectIdCode: error.projectIdCode },
        cause: error,
      });
    }
    throw error;
  }
}

export function createCloudAccountProjectIdProcedures(
  getOperations: () => CloudAccountProjectIdOperations,
) {
  return {
    getAccountProjectId: os
      .input(GetAccountProjectIdInputSchema)
      .output(AccountProjectIdResultSchema)
      .handler(({ input }) => execute(() => getOperations().getAccountProjectId(input))),
    setAccountProjectId: os
      .input(SetAccountProjectIdInputSchema)
      .output(AccountProjectIdResultSchema)
      .handler(({ input }) => execute(() => getOperations().setAccountProjectId(input))),
    fetchAccountProjectId: os
      .input(FetchAccountProjectIdInputSchema)
      .output(AccountProjectIdResultSchema)
      .handler(({ input }) => execute(() => getOperations().fetchAccountProjectId(input))),
  };
}
