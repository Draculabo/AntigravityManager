import { ORPCError } from '@orpc/server';
import {
  readCloudAccountFileErrorCode,
  type CloudAccountFileErrorCode,
} from './cloud-account-file.schema';

export class CloudAccountFileError extends Error {
  constructor(readonly fileCode: CloudAccountFileErrorCode) {
    super('Cloud account file operation failed');
    this.name = 'CloudAccountFileError';
  }
}

export function toCloudAccountFileORPCError(error: unknown, fallback: CloudAccountFileErrorCode) {
  const fileCode =
    readCloudAccountFileErrorCode(error) ??
    (error instanceof CloudAccountFileError ? error.fileCode : fallback);
  return new ORPCError(
    fileCode === 'invalid-export' || fileCode === 'file-too-large'
      ? 'BAD_REQUEST'
      : 'INTERNAL_SERVER_ERROR',
    {
      message: 'Cloud account file operation failed',
      data: { fileCode },
    },
  );
}
