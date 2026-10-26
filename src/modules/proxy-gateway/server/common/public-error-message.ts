import { redactDiagnosticText } from '@/shared/observability/sentryPrivacy';

const MAX_PUBLIC_ERROR_MESSAGE_BYTES = 2048;
const TRUNCATION_MARKER = '…';

/** Project readable error text without mutating the diagnostic cause or status input. */
export function publicProxyErrorMessage(message: string): string {
  // Apply the limit to the final public text, including any expansion caused by redaction.
  const redacted = redactDiagnosticText(message)
    .replace(/\r?\n\s*at [^\r\n]*/gu, '')
    .replace(/\b[A-Z]:[\\/][^\s"'<>]+/giu, '[PATH REDACTED]')
    .replace(
      /(^|[\s("'=])\/(?:home|Users|usr|opt|app|srv|var|tmp|etc|workspace|project|root)\/[^\s"'<>]+/gu,
      '$1[PATH REDACTED]',
    );
  if (!redacted.trim()) {
    return 'Request failed.';
  }
  if (Buffer.byteLength(redacted, 'utf8') <= MAX_PUBLIC_ERROR_MESSAGE_BYTES) {
    return redacted;
  }

  const limit = MAX_PUBLIC_ERROR_MESSAGE_BYTES - Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  let result = '';
  let bytes = 0;
  for (const character of redacted) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > limit) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result + TRUNCATION_MARKER;
}
