import { describe, expect, it } from 'vitest';
import {
  readCloudAccountSwitchDiagnosticCode,
  toCloudAccountSwitchORPCError,
} from '@/modules/cloud-account/services/cloud-account-switch.error';

describe('cloud account switch diagnostic codes', () => {
  it.each(['EACCES', 'SQLITE_BUSY', 'locked', 'malformed', 'timed-out'])(
    'retains the known category %s without provider text',
    (code) => {
      const error = Object.assign(new Error('access_token=fixture-secret /Users/alice/private'), {
        code,
      });
      expect(readCloudAccountSwitchDiagnosticCode(error)).toBe(code);
    },
  );

  it('identifies failed credential readback without attaching the credential values', () => {
    expect(
      readCloudAccountSwitchDiagnosticCode(
        new Error('Client credential-store write could not be confirmed'),
      ),
    ).toBe('credential-readback-mismatch');
  });

  it('does not forward unexpected native error codes or causes', () => {
    const error = Object.assign(new Error('private-provider'), {
      code: 'fixture-secret',
      cause: new Error('access_token=fixture-secret'),
    });
    expect(readCloudAccountSwitchDiagnosticCode(error)).toBe('unknown');
    const publicError = toCloudAccountSwitchORPCError(error);
    expect(publicError.data).toEqual({ switchCode: 'switch-failed' });
    expect(publicError.message).toBe('Cloud account switch failed');
    expect(publicError.cause).toBeUndefined();
  });
});
