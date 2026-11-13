import { z } from 'zod';
import { CloudAccountIdSchema } from './cloud-account-mutation.schema';

export const CloudAccountProjectIdSchema = z
  .string()
  .trim()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((id) => !/^(?:projects|cloud-code-\d+)$/iu.test(id));

// Legacy profiles can contain IDs that would fail validation for new values.
const StoredProjectIdSchema = z.string().nullable();

export const GetAccountProjectIdInputSchema = z.strictObject({
  accountId: CloudAccountIdSchema,
});

export const FetchAccountProjectIdInputSchema = GetAccountProjectIdInputSchema.extend({
  expectedProjectId: StoredProjectIdSchema,
});

export const SetAccountProjectIdInputSchema = FetchAccountProjectIdInputSchema.extend({
  projectId: CloudAccountProjectIdSchema.nullable(),
});

export const AccountProjectIdResultSchema = z.strictObject({
  projectId: StoredProjectIdSchema,
});

export type GetAccountProjectIdInput = z.infer<typeof GetAccountProjectIdInputSchema>;
export type SetAccountProjectIdInput = z.infer<typeof SetAccountProjectIdInputSchema>;
export type FetchAccountProjectIdInput = z.infer<typeof FetchAccountProjectIdInputSchema>;
export type AccountProjectIdResult = z.infer<typeof AccountProjectIdResultSchema>;

export interface CloudAccountProjectIdOperations {
  getAccountProjectId(input: GetAccountProjectIdInput): Promise<AccountProjectIdResult>;
  setAccountProjectId(input: SetAccountProjectIdInput): Promise<AccountProjectIdResult>;
  fetchAccountProjectId(input: FetchAccountProjectIdInput): Promise<AccountProjectIdResult>;
}

export const AccountProjectIdErrorDataSchema = z.strictObject({
  projectIdCode: z.enum([
    'account-not-found',
    'unsupported-account',
    'project-id-changed',
    'project-id-unavailable',
    'project-id-fetch-failed',
  ]),
});

export type AccountProjectIdErrorCode = z.infer<
  typeof AccountProjectIdErrorDataSchema
>['projectIdCode'];
