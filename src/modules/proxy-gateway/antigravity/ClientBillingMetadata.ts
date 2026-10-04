/**
 * Claude Code puts transport billing metadata in system text blocks. Google rejects
 * those blocks with 429 even when the same request's tools and account are usable.
 * Remove only complete metadata lines; quoted examples and code remain unchanged.
 */
export function stripClaudeBillingMetadata(text: string): string {
  const protectedCode = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\r\n]*`)/g;
  return text
    .split(protectedCode)
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment.replace(
            /^[\t ]*x-anthropic-billing-header:[\t ]*cc_version=[^\r\n]*(?:\r?\n|$)/gim,
            '',
          ),
    )
    .join('');
}
