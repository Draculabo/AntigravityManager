import { redactDiagnosticText } from '@/shared/observability/sentryPrivacy';

const VENDOR_CREDENTIAL =
  /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;
const EXTRA_QUERY_CREDENTIAL = /^(?:api-?key|token|auth|sig|signature)$/i;

export function maskShareableLogText(message: string): string {
  return redactDiagnosticText(message)
    .replace(/([?&])([^&#\s=]+)=[^&#\s"'<>]*/g, (parameter, separator: string, name: string) => {
      const decoded = new URLSearchParams(`${name}=`).keys().next().value;
      return decoded && EXTRA_QUERY_CREDENTIAL.test(decoded)
        ? `${separator}${name}=***`
        : parameter;
    })
    .replace(VENDOR_CREDENTIAL, '***')
    .replace(/\[(?:EMAIL )?REDACTED\](?: \[REDACTED\])?/g, '***')
    .replace(/[\r\n\u2028\u2029]+/g, ' ');
}
