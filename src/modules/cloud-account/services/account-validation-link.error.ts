import { ORPCError } from '@orpc/server';
import { AccountValidationLinkError } from './account-validation-link.service';
import {
  readAccountValidationLinkErrorCode,
  type AccountValidationLinkErrorCode,
} from './account-validation-link.schema';

export function toAccountValidationLinkORPCError(error: unknown) {
  const validationCode: AccountValidationLinkErrorCode =
    readAccountValidationLinkErrorCode(error) ??
    (error instanceof AccountValidationLinkError ? error.validationCode : 'validation-link-failed');
  const status =
    validationCode === 'account-not-found'
      ? 'NOT_FOUND'
      : validationCode === 'no-trusted-link'
        ? 'BAD_REQUEST'
        : 'INTERNAL_SERVER_ERROR';
  return new ORPCError(status, {
    message: 'Account validation link is unavailable',
    data: { validationCode },
  });
}
