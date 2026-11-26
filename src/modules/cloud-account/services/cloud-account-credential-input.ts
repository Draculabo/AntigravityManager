import { z } from 'zod';

const MAX_BATCH_BYTES = 256 * 1024;
const MAX_BATCH_ITEMS = 100;
const MAX_REFRESH_TOKEN_BYTES = 2048;

// Refresh tokens are opaque. Google verifies them; this boundary only accepts one value per row.
export const PastedRefreshTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_REFRESH_TOKEN_BYTES)
  .regex(/^[A-Za-z0-9._~+/=-]+$/u);

const CredentialFieldsSchema = z.object({
  refresh_token: PastedRefreshTokenSchema.optional(),
  refreshToken: PastedRefreshTokenSchema.optional(),
});
const CredentialRecordSchema = CredentialFieldsSchema.extend({
  token: CredentialFieldsSchema.optional(),
});
const CredentialListSchema = z.object({ accounts: z.array(z.unknown()) });

type CredentialInputResult =
  | { status: 'ready'; credentials: readonly string[]; duplicates: number }
  | { status: 'invalid'; reason: 'empty' | 'invalid-format' | 'too-many' | 'too-large' };

function credentialFromEntry(entry: unknown): string | undefined {
  const direct = PastedRefreshTokenSchema.safeParse(entry);
  if (direct.success) {
    return direct.data;
  }
  const record = CredentialRecordSchema.safeParse(entry);
  if (!record.success) {
    return undefined;
  }
  const { refresh_token, refreshToken, token } = record.data;
  const matches = [refresh_token, refreshToken, token?.refresh_token, token?.refreshToken].filter(
    (value) => value !== undefined,
  );
  if (matches.every((value) => value === matches[0])) {
    return matches[0];
  }
  return undefined;
}

export function parseCloudAccountCredentialInput(text: string): CredentialInputResult {
  if (text.length > MAX_BATCH_BYTES || new TextEncoder().encode(text).length > MAX_BATCH_BYTES) {
    return { status: 'invalid', reason: 'too-large' };
  }
  const input = text.trim();
  if (!input) {
    return { status: 'invalid', reason: 'empty' };
  }

  let entries: unknown[];
  if (input.startsWith('{') || input.startsWith('[')) {
    let json: unknown;
    try {
      json = JSON.parse(input);
    } catch {
      return { status: 'invalid', reason: 'invalid-format' };
    }
    const list = CredentialListSchema.safeParse(json);
    entries = Array.isArray(json) ? json : list.success ? list.data.accounts : [json];
  } else {
    entries = input.split(/\r?\n/u).filter((line) => line.trim());
  }
  if (entries.length === 0) {
    return { status: 'invalid', reason: 'empty' };
  }
  if (entries.length > MAX_BATCH_ITEMS) {
    return { status: 'invalid', reason: 'too-many' };
  }

  const credentials = new Set<string>();
  for (const entry of entries) {
    const token = credentialFromEntry(entry);
    if (!token) {
      return { status: 'invalid', reason: 'invalid-format' };
    }
    credentials.add(token);
  }
  return {
    status: 'ready',
    credentials: [...credentials],
    duplicates: entries.length - credentials.size,
  };
}
