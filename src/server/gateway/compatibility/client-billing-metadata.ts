import { overlapsPromptProtection, promptProtectedRegions } from './prompt-protected-regions';

/**
 * Claude Code puts transport billing metadata in system text blocks. Google rejects
 * those blocks with 429 even when the same request's tools and account are usable.
 * Remove only complete metadata lines; quoted examples and code remain unchanged.
 */
export function stripClaudeBillingMetadata(text: string): string {
  const protectedRegions = promptProtectedRegions(text);
  return text.replace(
    /^[\t ]*x-anthropic-billing-header:[^\r\n]*(?:\r?\n|$)/gim,
    (line: string, offset: number) =>
      overlapsPromptProtection(protectedRegions, offset, offset + line.length) ? line : '',
  );
}
