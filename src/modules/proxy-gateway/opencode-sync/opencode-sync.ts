import { homedir } from 'node:os';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { openCodeCredentialService } from './opencode-credentials';
import { OpenCodeSyncService } from './opencode-sync.service';

export const openCodeSyncService = new OpenCodeSyncService(
  homedir(),
  openCodeCredentialService,
  undefined,
  async () => {
    const accounts = await CloudAccountRepo.getAccounts();
    return accounts.map((account) => ({
      email: account.email,
      refreshToken: account.token.refresh_token,
      ...(account.token.project_id ? { projectId: account.token.project_id } : {}),
      lastUsed: account.last_used,
    }));
  },
);
