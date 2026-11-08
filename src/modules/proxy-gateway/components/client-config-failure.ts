import { z } from 'zod';
import { ClientConfigErrorCodeSchema } from '../agent-tools/client-config.schema';
import { ConnectionProfileErrorCodeSchema } from '../connection-profiles/connection-profiles.schema';
import { DshErrorCodeSchema } from '../dsh-sync/dsh-owner.schema';

const envelope = z.object({ data: z.object({
  clientConfigCode: ClientConfigErrorCodeSchema.optional(),
  dshCode: DshErrorCodeSchema.optional(),
  connectionProfileCode: ConnectionProfileErrorCodeSchema.optional(),
}) });
export type ClientConfigFailureNotice = 'receipt-failed' | 'config-conflict' | 'config-invalid' | 'config-read-failed' | 'config-key-missing' | 'config-backup-failed' | 'config-unavailable' | 'config-home-missing' | 'config-write-failed' | 'failed';
export function readClientConfigFailure(error: unknown): ClientConfigFailureNotice {
  const parsed = envelope.safeParse(error);
  const code = parsed.success ? parsed.data.data.clientConfigCode ?? parsed.data.data.dshCode ?? parsed.data.data.connectionProfileCode : null;
  switch (code) {
    case 'receipt-failed':
    case 'write-unconfirmed':
      return 'receipt-failed';
    case 'conflict':
      return 'config-conflict';
    case 'invalid-config':
      return 'config-invalid';
    case 'read-failed':
      return 'config-read-failed';
    case 'key-missing':
      return 'config-key-missing';
    case 'backup-failed':
      return 'config-backup-failed';
    case 'unavailable':
      return 'config-unavailable';
    case 'home-missing':
      return 'config-home-missing';
    case 'write-failed':
      return 'config-write-failed';
    default:
      return 'failed';
  }
}
