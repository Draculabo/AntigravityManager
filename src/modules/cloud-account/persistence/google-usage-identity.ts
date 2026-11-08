import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CloudTokenData } from '../types';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const proofSchema = z.strictObject({ subject: digest, binding: digest });

export function googleUsageGrantHash(token: CloudTokenData): string | null {
  const credential = token.refresh_token || token.access_token;
  if (!credential) {
    return null;
  }
  return createHash('sha256')
    .update(JSON.stringify(['google-usage-grant-v1', token.refresh_token ? 'refresh' : 'access', credential, token.oauth_client_key ?? null]))
    .digest('hex');
}

export function createGoogleUsageIdentity(subject: string, token: CloudTokenData): string | null {
  const grant = googleUsageGrantHash(token);
  if (!grant || !subject.trim() || Buffer.byteLength(subject, 'utf8') > 1024) {
    return null;
  }
  return JSON.stringify({
    subject: createHash('sha256').update(JSON.stringify(['google-usage-subject-v1', subject])).digest('hex'),
    binding: grant,
  });
}

export function readGoogleUsageIdentity(value: string | null, token: CloudTokenData): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = proofSchema.safeParse(JSON.parse(value));
    return parsed.success && parsed.data.binding === googleUsageGrantHash(token) ? parsed.data.subject : undefined;
  } catch {
    return undefined;
  }
}

export function bindGoogleUsageIdentity(subject: string, token: CloudTokenData): string | null {
  const grant = googleUsageGrantHash(token);
  return grant ? JSON.stringify({ subject, binding: grant }) : null;
}
