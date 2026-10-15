import type { DesktopOAuthLoginErrorCode } from '@/modules/cloud-account/services/desktop-oauth-login.schema';
import type { GoogleLoginDiagnostic } from '@/modules/cloud-account/services/operation-diagnostic.schema';

export const diagnosticId = '11111111-1111-4111-8111-222222222222';

export function loginDiagnostic(
  code: DesktopOAuthLoginErrorCode,
  id = diagnosticId,
): GoogleLoginDiagnostic {
  const reasons: { [Code in DesktopOAuthLoginErrorCode]: GoogleLoginDiagnostic['reason'] } = {
    'authorization-denied': 'authorization-denied',
    'login-active': 'login-active',
    'login-cancelled': 'cancelled',
    'login-timeout': 'timed-out',
    'duplicate-account': 'duplicate-account',
    'browser-open-failed': 'unknown',
    'proxy-configuration-invalid': 'proxy-configuration-invalid',
    'login-failed': 'unknown',
  };
  return {
    schemaVersion: 1,
    diagnosticId: id,
    operation: 'google-login',
    stage: 'authorization',
    reason: reasons[code],
    accountCommit: 'not-attempted',
    causes: [],
    reporting: {
      state: 'not-reported',
      reason: [
        'authorization-denied',
        'login-active',
        'login-cancelled',
        'duplicate-account',
      ].includes(code)
        ? 'expected-outcome'
        : 'disabled',
    },
  };
}
