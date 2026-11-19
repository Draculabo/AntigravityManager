import { stripClaudeBillingMetadata } from '@/server/gateway/compatibility/client-billing-metadata';

/**
 * Preserve user supplied system text byte-for-byte apart from the explicitly
 * owned billing metadata lines. Dynamic dates, paths, UUIDs and session IDs are
 * part of the request identity and must not be rewritten for cache-key reuse.
 */
export function sanitizeSystemInstructionForCache(text: string): string {
  // Keep this compatibility helper semantically lossless. Dynamic facts and
  // whitespace are part of the caller's prompt; cache behavior must not rewrite
  // the request to make otherwise different prefixes look identical.
  return stripClaudeBillingMetadata(text);
}
