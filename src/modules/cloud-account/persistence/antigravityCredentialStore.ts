import { Entry } from '@napi-rs/keyring';
import { execFileSync, spawnSync } from 'child_process';
import { logger } from '@/shared/logging/logger';

export interface CredentialStoreTokenInput {
  access_token: string;
  refresh_token: string;
  expiry_timestamp: number;
}

function buildCredentialStorePayload(token: CredentialStoreTokenInput): string {
  const expiry = new Date(token.expiry_timestamp * 1000)
    .toISOString()
    .replace(/\.(\d{3})Z$/, '.$1000Z');
  return JSON.stringify({
    token: {
      access_token: token.access_token,
      token_type: 'Bearer',
      refresh_token: token.refresh_token,
      expiry,
    },
    auth_method: 'consumer',
  });
}

function isSecretToolAvailable(): boolean {
  const versionResult = spawnSync('secret-tool', ['--version'], {
    stdio: 'ignore',
    timeout: 3000,
  });
  return !versionResult.error && versionResult.status === 0;
}

function writeViaNativeKeyring(payload: string): void {
  const entry = Entry.withTarget('gemini:antigravity', 'gemini', 'antigravity');
  try {
    entry.deleteCredential();
  } catch {
    // Missing previous credential is acceptable.
  }

  entry.setSecret(Buffer.from(payload, 'utf-8'));
}

function writeViaSecretTool(payload: string): void {
  const storeResult = spawnSync(
    'secret-tool',
    ['store', '--label=gemini', 'service', 'gemini', 'username', 'antigravity'],
    { input: payload, encoding: 'utf-8', timeout: 10000 },
  );
  if (!storeResult.error && storeResult.status === 0) {
    return;
  }

  throw new Error(
    `Linux secret-tool failed: ${storeResult.stderr || storeResult.error?.message || 'unknown error'}`,
  );
}

export function writeAntigravityCredentialStoreToken(token: CredentialStoreTokenInput): void {
  const payload = buildCredentialStorePayload(token);
  logger.info('Writing Antigravity token to system credential store');

  if (process.platform === 'darwin') {
    const value = `go-keyring-base64:${Buffer.from(payload, 'utf-8').toString('base64')}`;
    try {
      execFileSync('security', ['delete-generic-password', '-s', 'gemini', '-a', 'antigravity'], {
        stdio: 'ignore',
      });
    } catch {
      // Missing previous credential is acceptable.
    }

    execFileSync(
      'security',
      ['add-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w', value, '-A'],
      { stdio: 'ignore' },
    );
    return;
  }

  if (process.platform === 'linux' && isSecretToolAvailable()) {
    try {
      writeViaSecretTool(payload);
      return;
    } catch (error) {
      logger.warn('Linux secret-tool failed; falling back to native keyring', error);
    }
  }

  writeViaNativeKeyring(payload);
}
