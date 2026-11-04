import { credentials, state } from '../support/client-account-write-fixture';
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  prepareClientAccountWrite,
  resolveClientAccountStorage,
} from '@/modules/antigravity-runtime/credentials/clientAccountWrite';
import { getAntigravityDbPaths } from '@/shared/platform/paths';
import { getAntigravityVersion } from '@/modules/antigravity-runtime/utils/antigravityVersion';
import { ProtobufUtils } from '@/shared/serialization/protobuf';
import {
  readAntigravityCredentialStoreToken,
  writeAntigravityCredentialStoreToken,
} from '@/modules/antigravity-runtime/credentials/antigravityCredentialStore';

describe('client account destination', () => {
  it('routes macOS IDE 2.6 to credentials while retaining older IDE SQLite routing', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    expect(await resolveClientAccountStorage('ide')).toBe('sqlite');
    vi.mocked(getAntigravityVersion).mockResolvedValue({
      shortVersion: '2.6.0',
      bundleVersion: '2.6.0',
    });
    expect(await resolveClientAccountStorage('ide')).toBe('credential-store');
  });
  it('keeps an explicit CLI switch out of the host credential store', async () => {
    const prepared = await prepareClientAccountWrite(credentials, 'agy');

    expect(prepared.storage).toBe('cli-session');
    await prepared.write();

    expect(writeAntigravityCredentialStoreToken).not.toHaveBeenCalled();
    expect(state.writeAgyCliToken).toHaveBeenCalledExactlyOnceWith(expect.any(String));
    expect(state.writeGoogleOAuthCredentials).toHaveBeenCalledExactlyOnceWith({
      ...credentials.token,
      email: credentials.email,
    });
  });

  it('reports required CLI OAuth file failures without changing host credentials', async () => {
    state.writeGoogleOAuthCredentials.mockImplementationOnce(() => {
      throw new Error('file sync failed');
    });
    const prepared = await prepareClientAccountWrite(credentials, 'agy');

    await expect(prepared.write()).rejects.toThrow('file sync failed');

    expect(writeAntigravityCredentialStoreToken).not.toHaveBeenCalled();
  });

  it('confirms complete native credentials and rejects a stale readback', async () => {
    vi.mocked(getAntigravityVersion).mockResolvedValue({
      shortVersion: '2.18.1',
      bundleVersion: '2.18.1',
    });
    const prepared = await prepareClientAccountWrite(credentials, 'classic');
    vi.mocked(readAntigravityCredentialStoreToken).mockResolvedValue({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiryTimestamp: 1800000000,
      idToken: 'id-token',
      projectId: 'project-a',
    });
    await prepared.write();
    expect(writeAntigravityCredentialStoreToken).toHaveBeenCalledExactlyOnceWith(
      credentials.token,
      { syncClassicOAuthFile: true },
    );
    vi.mocked(readAntigravityCredentialStoreToken).mockResolvedValue({
      accessToken: 'old-access',
      refreshToken: 'refresh',
      expiryTimestamp: 1800000000,
    });
    await expect(prepared.write()).rejects.toThrow('could not be confirmed');
  });
  it('synchronizes Windows IDE 2.6 desktop state, native credentials and standalone fallback', async () => {
    vi.mocked(getAntigravityVersion).mockResolvedValue({
      shortVersion: '2.6.0',
      bundleVersion: '2.6.0',
    });
    vi.mocked(readAntigravityCredentialStoreToken).mockResolvedValue({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiryTimestamp: 1800000000,
      idToken: 'id-token',
      projectId: 'project-a',
    });

    const pathOptions = {
      userDataDir: '/fixture/isolated-ide',
      executablePath: '/fixture/ide.exe',
    };
    const prepared = await prepareClientAccountWrite(credentials, 'ide', pathOptions);
    expect(prepared.storage).toBe('credential-store');
    await prepared.write();

    expect(writeAntigravityCredentialStoreToken).toHaveBeenCalledExactlyOnceWith(
      credentials.token,
      {},
    );
    expect(readAntigravityCredentialStoreToken).toHaveBeenCalledTimes(1);
    expect(getAntigravityDbPaths).toHaveBeenCalledWith('ide', pathOptions);
    expect(JSON.parse(state.rows.get('antigravityAuthStatus')!)).toEqual({
      name: credentials.name,
      email: credentials.email,
      apiKey: credentials.token.access_token,
    });
    expect(state.writeStandalone).toHaveBeenCalledExactlyOnceWith(credentials.token);
    expect(state.prepareRecovery).toHaveBeenCalledExactlyOnceWith('/fixture/state.vscdb');
  });
  it('does not expand workspace provisioning to the ordinary IDE switch destinations', async () => {
    vi.mocked(getAntigravityVersion).mockResolvedValue({
      shortVersion: '2.6.0',
      bundleVersion: '2.6.0',
    });
    vi.mocked(readAntigravityCredentialStoreToken).mockResolvedValue({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiryTimestamp: 1800000000,
      idToken: 'id-token',
      projectId: 'project-a',
    });
    const prepared = await prepareClientAccountWrite(credentials, 'ide', undefined, 'workspace');
    await prepared.write();
    expect(state.opens).not.toHaveBeenCalled();
    expect(state.writeStandalone).not.toHaveBeenCalled();
    expect(state.prepareRecovery).not.toHaveBeenCalled();
  });
  it('rejects an inaccessible IDE 2.6 database during preflight before touching native credentials', async () => {
    vi.mocked(getAntigravityVersion).mockResolvedValue({
      shortVersion: '2.6.0',
      bundleVersion: '2.6.0',
    });
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw new Error('access denied');
    });
    await expect(prepareClientAccountWrite(credentials, 'ide')).rejects.toThrow('access denied');
    expect(writeAntigravityCredentialStoreToken).not.toHaveBeenCalled();
  });
  it.each(['sqlite', 'native', 'readback', 'standalone'] as const)(
    'reports a required %s failure instead of completing a partial IDE switch',
    async (failure) => {
      vi.mocked(getAntigravityVersion).mockResolvedValue({
        shortVersion: '2.6.0',
        bundleVersion: '2.6.0',
      });
      vi.mocked(readAntigravityCredentialStoreToken).mockResolvedValue({
        accessToken: 'access',
        refreshToken: 'refresh',
        expiryTimestamp: 1800000000,
        idToken: 'id-token',
        projectId: 'project-a',
      });
      if (failure === 'sqlite') {
        state.failKey = 'antigravityAuthStatus';
      }
      if (failure === 'native') {
        vi.mocked(writeAntigravityCredentialStoreToken).mockRejectedValueOnce(
          new Error('native failed'),
        );
      }
      if (failure === 'readback') {
        vi.mocked(readAntigravityCredentialStoreToken).mockResolvedValueOnce(null);
      }
      if (failure === 'standalone') {
        state.writeStandalone.mockImplementationOnce(() => {
          throw new Error('standalone failed');
        });
      }
      const prepared = await prepareClientAccountWrite(credentials, 'ide');
      await expect(prepared.write()).rejects.toThrow();
      if (failure === 'sqlite') {
        expect(writeAntigravityCredentialStoreToken).not.toHaveBeenCalled();
      }
      if (failure !== 'standalone') {
        expect(state.writeStandalone).not.toHaveBeenCalled();
      }
    },
  );
  it('routes IDE, CLI and Classic versions without old-format or engine guesses', async () => {
    expect(await resolveClientAccountStorage('ide')).toBe('sqlite');
    vi.mocked(getAntigravityVersion).mockResolvedValue({
      shortVersion: '2.6.0',
      bundleVersion: '2.6.0',
    });
    expect(await resolveClientAccountStorage('ide')).toBe('credential-store');
    expect(await resolveClientAccountStorage('agy')).toBe('cli-session');
    vi.mocked(getAntigravityVersion).mockResolvedValue({
      shortVersion: '2.18.1',
      bundleVersion: '2.18.1',
    });
    expect(await resolveClientAccountStorage('classic')).toBe('credential-store');
    vi.mocked(getAntigravityVersion).mockResolvedValue({
      shortVersion: '1.107.0',
      bundleVersion: '1.107.0',
    });
    expect(await resolveClientAccountStorage('classic')).toBe('sqlite');
  });
  it('uses only the selected installation database when product version is unavailable', async () => {
    vi.mocked(getAntigravityVersion).mockRejectedValue(new Error('missing version'));
    expect(await resolveClientAccountStorage('classic', { userDataDir: '/fixture/data' })).toBe(
      'sqlite',
    );
    expect(getAntigravityDbPaths).toHaveBeenCalledWith('classic', { userDataDir: '/fixture/data' });
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(await resolveClientAccountStorage('classic')).toBe('credential-store');
  });
  it('rejects credentials and inaccessible data paths before writing', async () => {
    await expect(prepareClientAccountWrite({ ...credentials, email: '' }, 'ide')).rejects.toThrow(
      'identity',
    );
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw new Error('access denied');
    });
    await expect(prepareClientAccountWrite(credentials, 'ide')).rejects.toThrow('access denied');
    expect(state.opens).not.toHaveBeenCalled();
  });
});

describe('unified client account writes', () => {
  it('synchronizes Linux IDE desktop, Agent credentials and fallback while preserving workspace routing', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.mocked(getAntigravityVersion).mockResolvedValue({
      shortVersion: '2.6.0',
      bundleVersion: '2.6.0',
    });
    const prepared = await prepareClientAccountWrite(credentials, 'ide');
    expect(prepared.storage).toBe('credential-store');
    await prepared.write();
    expect(JSON.parse(state.rows.get('antigravityAuthStatus')!).email).toBe(credentials.email);
    expect(state.prepareLinuxRecovery).toHaveBeenCalledExactlyOnceWith('/fixture/state.vscdb');
    expect(state.writeLinuxPayload).toHaveBeenCalledExactlyOnceWith(expect.any(String));
    expect(JSON.parse(state.writeLinuxPayload.mock.calls[0][0]).token.refresh_token).toBe(
      credentials.token.refresh_token,
    );
    expect(state.writeStandalone).toHaveBeenCalledExactlyOnceWith(credentials.token);
    expect(writeAntigravityCredentialStoreToken).not.toHaveBeenCalled();
    state.prepareLinuxRecovery.mockClear();
    state.writeLinuxPayload.mockClear();
    state.writeStandalone.mockClear();
    const workspace = await prepareClientAccountWrite(credentials, 'ide', undefined, 'workspace');
    expect(workspace.storage).toBe('sqlite');
    await workspace.write();
    expect(state.prepareLinuxRecovery).not.toHaveBeenCalled();
    expect(state.writeLinuxPayload).not.toHaveBeenCalled();
    expect(state.writeStandalone).not.toHaveBeenCalled();
  });
  it('fails Linux IDE switching when Secret Service cannot confirm the write', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.mocked(getAntigravityVersion).mockResolvedValue({
      shortVersion: '2.6.0',
      bundleVersion: '2.6.0',
    });
    state.writeLinuxPayload.mockRejectedValueOnce(new Error('collection readback mismatch'));
    const prepared = await prepareClientAccountWrite(credentials, 'ide');
    await expect(prepared.write()).rejects.toThrow('collection readback mismatch');
    expect(state.writeStandalone).not.toHaveBeenCalled();
  });
  it('preserves unrelated OAuth topic rows, writes complete identity and removes stale state', async () => {
    const preserved = ProtobufUtils.createUnifiedTopicEntry(
      'otherSentinel',
      new Uint8Array([4, 5, 6]),
    );
    state.rows.set(
      'antigravityUnifiedStateSync.oauthToken',
      Buffer.from(preserved).toString('base64'),
    );
    state.rows.set('jetskiStateSync.agentManagerInitState', 'previous-user');
    state.rows.set('google.antigravity', 'previous-cache');
    state.rows.set('workspace.unrelated', 'keep');
    const prepared = await prepareClientAccountWrite(credentials, 'ide');
    await prepared.write();
    const oauth = state.rows.get('antigravityUnifiedStateSync.oauthToken')!;
    expect(
      ProtobufUtils.decodeUnifiedStateTopicEntries(new Uint8Array(Buffer.from(oauth, 'base64')))[0],
    ).toEqual({ sentinelKey: 'otherSentinel', payload: new Uint8Array([4, 5, 6]) });
    expect(ProtobufUtils.extractOAuthTokenDetailsFromUnifiedStateEntry(oauth)).toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiryTimestamp: 1800000000,
      idToken: 'id-token',
      isGcpTos: true,
    });
    expect(state.rows.has('jetskiStateSync.agentManagerInitState')).toBe(false);
    expect(state.rows.has('google.antigravity')).toBe(false);
    expect(state.rows.get('workspace.unrelated')).toBe('keep');
    expect(state.rows.get('antigravityOnboarding')).toBe('true');
  });
  it('clears the previous project, captures the destination once and preserves one recovery snapshot', async () => {
    state.rows.set('antigravityUnifiedStateSync.enterprisePreferences', 'previous-project');
    const input = structuredClone(credentials);
    delete input.token.project_id;
    const prepared = await prepareClientAccountWrite(input, 'ide');
    input.token.access_token = 'changed-after-preparation';
    vi.mocked(getAntigravityDbPaths).mockReturnValue(['/other/state.vscdb']);
    await prepared.write();
    await prepared.write();
    expect(state.opens.mock.calls).toEqual([
      ['/fixture/state.vscdb'],
      ['/fixture/state.vscdb'],
      ['/fixture/state.vscdb'],
    ]);
    expect(state.backups).toHaveBeenCalledExactlyOnceWith(
      '/fixture/state.vscdb.account-switch.backup',
      expect.objectContaining({ progress: expect.any(Function) }),
    );
    expect(state.rows.has('antigravityUnifiedStateSync.enterprisePreferences')).toBe(false);
    expect(
      ProtobufUtils.extractOAuthTokenDetailsFromUnifiedStateEntry(
        state.rows.get('antigravityUnifiedStateSync.oauthToken')!,
      )?.accessToken,
    ).toBe('access');
  });
  it('rolls back all account writes when the primary store fails and never writes a recovery copy', async () => {
    state.rows.set('workspace.unrelated', 'keep');
    const previous = new Map(state.rows);
    state.failKey = 'antigravityAuthStatus';
    const prepared = await prepareClientAccountWrite(credentials, 'ide');
    await expect(prepared.write()).rejects.toThrow('write failed');
    expect(state.rows).toEqual(previous);
    expect(state.opens.mock.calls).toEqual([['/fixture/state.vscdb'], ['/fixture/state.vscdb']]);
  });
});
