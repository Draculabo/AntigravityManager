import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { hasErrorCode } from '@/shared/errors/error-guards';
import { writeFileAtomic } from '@/shared/persistence/atomic-json-file';

export const USERNAME = 'jetski.onboarding.lastLoginUsername';
export const TERMS_TYPE = 'jetski.onboarding.lastLoginIsGcpTos';
const MAX_FILE_BYTES = 1024 * 1024;
const DocumentSchema = z.record(z.string(), z.json());
const AcceptanceSchema = z.object({
  [USERNAME]: z.string().min(1).max(320),
  [TERMS_TYPE]: z.enum(['false', 'true']),
});
const EntrySchema = z.strictObject({
  account: z.string().regex(/^[a-f0-9]{64}$/),
  termsType: z.enum(['false', 'true']),
});
export const TermsHistorySchema = z.strictObject({
  version: z.literal(1),
  revision: z.string().min(1).max(512),
  entries: z.array(EntrySchema).max(256),
});
export type TermsHistory = z.infer<typeof TermsHistorySchema>;
export type TermsDocument = z.infer<typeof DocumentSchema>;
export type AcceptedTerms = { email: string; termsType: 'false' | 'true' };

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Reject links and oversized input before parsing either official or Manager-owned state. */
export async function readDocument(file: string): Promise<TermsDocument | null> {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw new Error('Classic terms storage is unavailable');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
    throw new Error('Classic terms storage is invalid');
  }
  try {
    const input: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return DocumentSchema.parse(input);
  } catch {
    throw new Error('Classic terms storage is invalid');
  }
}

export function acceptedTerms(document: TermsDocument | null): AcceptedTerms | null {
  const parsed = AcceptanceSchema.safeParse(document);
  return parsed.success
    ? { email: parsed.data[USERNAME], termsType: parsed.data[TERMS_TYPE] }
    : null;
}

export function mergeAcceptance(
  document: TermsDocument,
  acceptance: AcceptedTerms | null,
): TermsDocument {
  const next = { ...document };
  delete next[USERNAME];
  delete next[TERMS_TYPE];
  if (acceptance) {
    next[USERNAME] = acceptance.email;
    next[TERMS_TYPE] = acceptance.termsType;
  }
  return next;
}

export async function writeDocument(file: string, document: TermsDocument): Promise<void> {
  const serialized = JSON.stringify(document);
  if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) {
    throw new Error('Classic terms storage exceeds its limit');
  }
  await writeFileAtomic(file, serialized, { mode: 0o600 });
}

export function historyFile(agentDirectory: string, profile: string): string {
  return path.join(agentDirectory, 'classic-terms', digest(profile) + '.json');
}

export async function readHistory(
  file: string,
): Promise<{ state: 'missing' | 'invalid' } | { state: 'valid'; history: TermsHistory }> {
  try {
    const document = await readDocument(file);
    if (!document) {
      return { state: 'missing' };
    }
    const parsed = TermsHistorySchema.safeParse(document);
    return parsed.success ? { state: 'valid', history: parsed.data } : { state: 'invalid' };
  } catch {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
      throw new Error('Classic terms history is invalid');
    }
    return { state: 'invalid' };
  }
}
