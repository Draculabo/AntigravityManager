import { homedir } from 'node:os';
import { openCodeCredentialService } from './opencode-credentials';
import { OpenCodeSyncService } from './opencode-sync.service';

export const openCodeSyncService = new OpenCodeSyncService(homedir(), openCodeCredentialService);
