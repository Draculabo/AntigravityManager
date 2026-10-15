import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const AcceptanceStorageSchema = z.object({
  'jetski.onboarding.lastLoginUsername': z.string().optional(),
  'jetski.onboarding.lastLoginIsGcpTos': z.enum(['true', 'false']).optional(),
});

/** Inspect the official client's last accepted account without recording identity or changing consent. */
export async function readClassicTermsAcceptance(userDataDirectory, expectedEmail) {
  try {
    const file = path.join(userDataDirectory, 'app_storage.json');
    if ((await fs.stat(file)).size > 1000000) {
      return { state: 'unreadable' };
    }
    const parsed = AcceptanceStorageSchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')));
    if (!parsed.success) {
      return { state: 'unreadable' };
    }
    const email = parsed.data['jetski.onboarding.lastLoginUsername'];
    const flag = parsed.data['jetski.onboarding.lastLoginIsGcpTos'];
    if (!email || flag === undefined) {
      return { state: 'not-recorded' };
    }
    return {
      state: email === expectedEmail ? 'recorded' : 'other-account',
      tosType: flag === 'true' ? 'gcp' : 'standard',
    };
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'not-recorded' : 'unreadable' };
  }
}
