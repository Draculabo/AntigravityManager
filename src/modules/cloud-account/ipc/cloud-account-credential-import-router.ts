import { createCloudAccountCredentialImportRouter } from '../services/cloud-account-credential-import.transport';
import { getCloudAccountAdapter } from './cloud-account-adapter';

export const cloudAccountCredentialImportRouter = createCloudAccountCredentialImportRouter(
  (input) => getCloudAccountAdapter().importCredential(input),
);
