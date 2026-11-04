import { credentials, state } from '../support/client-account-write-fixture';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareClientAccountWrite } from '@/modules/antigravity-runtime/credentials/clientAccountWrite';
import { getAntigravityVersion } from '@/modules/antigravity-runtime/utils/antigravityVersion';
import { writeAntigravityCredentialStoreToken } from '@/modules/antigravity-runtime/credentials/antigravityCredentialStore';
import * as macSqlite from '@/modules/antigravity-runtime/credentials/macosClientSqlite';

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  vi.mocked(getAntigravityVersion).mockResolvedValue({
    shortVersion: '2.6.0',
    bundleVersion: '2.6.0',
  });
});

describe('macOS IDE 2.6 account write', () => {
  it('continues credential writes when service-machine synchronization fails', async () => {
    const machine = vi.spyOn(macSqlite, 'writeMacOSServiceMachineId').mockImplementationOnce(() => {
      throw new Error('machine write failed');
    });
    const prepared = await prepareClientAccountWrite(
      { ...credentials, serviceMachineId: 'synthetic-machine' },
      'ide',
    );
    await prepared.write();
    expect(machine).toHaveBeenCalledExactlyOnceWith('/fixture/state.vscdb', 'synthetic-machine');
    expect(state.writeMacPayload).toHaveBeenCalledOnce();
    expect(state.writeStandalonePayload).toHaveBeenCalledOnce();
  });
  it('writes desktop state before Keychain and credential files', async () => {
    const events: string[] = [];
    state.backups.mockImplementationOnce(async () => {
      events.push('sqlite-backup');
    });
    state.writeMacPayload.mockImplementationOnce(() => {
      events.push('keychain');
    });
    state.writeStandalonePayload.mockImplementationOnce(() => {
      events.push('files');
    });
    const input = structuredClone(credentials);
    const prepared = await prepareClientAccountWrite(input, 'ide');
    expect(events).toEqual([]);
    input.token.access_token = 'mutated-after-preflight';
    await prepared.write();
    expect(prepared.storage).toBe('credential-store');
    expect(events).toEqual(['sqlite-backup', 'keychain', 'files']);
    expect(JSON.parse(state.rows.get('antigravityAuthStatus')!)).toEqual({
      name: 'Fixture',
      email: 'fixture@example.org',
      apiKey: 'access',
    });
    const payload = state.writeMacPayload.mock.calls[0][0];
    expect(JSON.parse(payload)).toEqual({
      token: {
        access_token: 'access',
        refresh_token: 'refresh',
        token_type: 'Bearer',
        expiry: '2027-01-15T08:00:00.000000Z',
        expires_in: 3599,
      },
      auth_method: 'consumer',
      id_token: 'id-token',
      id_token_email: 'fixture@example.org',
    });
    expect(state.writeStandalonePayload).toHaveBeenCalledExactlyOnceWith(credentials, payload);
    expect(writeAntigravityCredentialStoreToken).not.toHaveBeenCalled();
    expect(state.writeAgyCliToken).not.toHaveBeenCalled();
    expect(state.writeGoogleOAuthCredentials).not.toHaveBeenCalled();
    expect(state.prepareRecovery).not.toHaveBeenCalled();
    expect(state.prepareLinuxRecovery).not.toHaveBeenCalled();
  });
  it('stops before Keychain and file writes when SQLite injection fails', async () => {
    state.failKey = 'antigravityAuthStatus';
    const prepared = await prepareClientAccountWrite(credentials, 'ide');
    await expect(prepared.write()).rejects.toThrow('write failed');
    expect(state.writeMacPayload).not.toHaveBeenCalled();
    expect(state.writeStandalonePayload).not.toHaveBeenCalled();
  });
  it('attempts file fallback after a failed Keychain write', async () => {
    state.writeMacPayload.mockImplementationOnce(() => {
      throw new Error('keychain failed');
    });
    const prepared = await prepareClientAccountWrite(credentials, 'ide');
    await prepared.write();
    expect(state.writeStandalonePayload).toHaveBeenCalledExactlyOnceWith(
      credentials,
      expect.any(String),
    );
  });
  it('leaves final authentication confirmation to the switch owner after mirror failure', async () => {
    state.writeStandalonePayload.mockImplementationOnce(() => {
      throw new Error('mirror failed');
    });
    const prepared = await prepareClientAccountWrite(credentials, 'ide');
    await expect(prepared.write()).resolves.toBeUndefined();
    expect(state.writeMacPayload).toHaveBeenCalledExactlyOnceWith(expect.any(String));
  });
  it('does not write shared Mac IDE credentials during workspace preparation', async () => {
    const prepared = await prepareClientAccountWrite(credentials, 'ide', undefined, 'workspace');
    expect(prepared.storage).toBe('sqlite');
    expect(state.writeMacPayload).not.toHaveBeenCalled();
    expect(state.writeStandalonePayload).not.toHaveBeenCalled();
  });
});
