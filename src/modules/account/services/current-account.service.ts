import axios from 'axios';
import { z } from 'zod';
import { readClientAccountToken, resolveClientAccountStorage } from '@/modules/antigravity-runtime';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import type { PathResolutionOptions } from '@/shared/platform/paths';
import { getCurrentAccountInfo as readSqliteAccountInfo } from '../persistence/antigravity-state-database';
import type { AccountInfo } from '../types';

const profileSchema = z.object({ email: z.email(), name: z.string().optional() });

/** Reports the selected client's stored identity; it does not authorize a Google request. */
export async function getCurrentAccountInfo(
  target?: AntigravityAppTarget | null,
  pathOptions?: PathResolutionOptions,
): Promise<AccountInfo> {
  if ((await resolveClientAccountStorage(target ?? undefined, pathOptions)) === 'sqlite') {
    return readSqliteAccountInfo(target, pathOptions);
  }
  const token = await readClientAccountToken(target);
  if (!token) {
    return { email: '', isAuthenticated: false };
  }
  if (token.idToken) {
    try {
      // Claims are display metadata from the local session, never authentication evidence.
      const payload: unknown = JSON.parse(
        Buffer.from(token.idToken.split('.')[1], 'base64url').toString('utf8'),
      );
      const profile = profileSchema.parse(payload);
      return { ...profile, isAuthenticated: true };
    } catch {
      // Older sessions may lack profile claims. Ask Google using the same stored access token.
    }
  }
  if (!token.accessToken) {
    throw new Error('Your saved login has expired. Sign in again to view the current account.');
  }
  const response = await axios.get<unknown>('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${token.accessToken}` },
    timeout: 10000,
  });
  return { ...profileSchema.parse(response.data), isAuthenticated: true };
}
