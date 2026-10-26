import { expect, vi } from 'vitest';
import { logger } from '@/shared/logging/logger';
import {
  CloudSwitchDiagnosticSchema,
  type CloudSwitchDiagnostic,
} from '@/modules/cloud-account/services/operation-diagnostic.schema';

export function expectTerminalDiagnostic(expected: Omit<CloudSwitchDiagnostic, 'diagnosticId'>) {
  const records = vi
    .mocked(logger.info)
    .mock.calls.filter((call) => call[0] === 'Operation diagnostic v1');
  expect(records).toHaveLength(1);
  const actual = CloudSwitchDiagnosticSchema.parse(records[0][1]);
  expect(records).toEqual([
    ['Operation diagnostic v1', { ...expected, diagnosticId: actual.diagnosticId }],
  ]);
}

export const account = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'google' as const,
  email: 'owner@example.com',
  name: 'Owner',
  avatar_url: null,
  token: {
    access_token: 'private-access-token',
    refresh_token: '',
    expires_in: 3600,
    expiry_timestamp: 1_700_000_000,
    token_type: 'Bearer',
  },
  device_profile: {
    machineId: 'machine',
    macMachineId: 'mac',
    devDeviceId: 'device',
    sqmId: '{SQM}',
  },
  created_at: 1,
  last_used: 1,
};
