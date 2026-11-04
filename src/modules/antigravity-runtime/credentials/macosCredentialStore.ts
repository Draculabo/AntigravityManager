import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'child_process';
import { z } from 'zod';
import type { CredentialStoreTokenInput } from '@/shared/auth/credentialStoreToken';
import { logger } from '@/shared/logging/logger';
import { redactDiagnosticText } from '@/shared/observability/sentryPrivacy';
import type { ClientAccountCredentials } from './clientAccount';
import { writeIdeStandaloneCredentialPayload } from './ideStandaloneToken';

const NestedRefreshTokenSchema = z.object({ token: z.object({ refresh_token: z.string() }) });
const RefreshTokenSchema = z.object({ refresh_token: z.string() });
const OAUTH_SCOPE =
  'https://www.googleapis.com/auth/userinfo.email openid https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.profile';

export function buildMacOSCredentialPayload(token: CredentialStoreTokenInput) {
  const seconds =
    token.expiry_timestamp > 10_000_000_000
      ? Math.trunc(token.expiry_timestamp / 1000)
      : token.expiry_timestamp;
  const date = new Date(seconds * 1000);
  const expiry = (Number.isFinite(date.getTime()) ? date : new Date())
    .toISOString()
    .replace(/\.(\d{3})Z$/, '.$1000Z');
  return {
    token: {
      access_token: token.access_token,
      token_type: 'Bearer',
      refresh_token: token.refresh_token,
      expiry,
    },
    auth_method: 'consumer',
    ...(token.id_token !== undefined ? { id_token: token.id_token } : {}),
  };
}

/** Decode the padded standard Base64 accepted by the credential format. */
export function decodeMacOSCredentialBase64(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new Error('Base64 decode failed');
  }
  return bytes;
}

function parseRefreshToken(payload: string): { refreshToken: string } {
  const parsed: unknown = JSON.parse(payload);
  const nested = NestedRefreshTokenSchema.safeParse(parsed);
  if (nested.success) {
    return { refreshToken: nested.data.token.refresh_token };
  }
  const flat = RefreshTokenSchema.safeParse(parsed);
  if (flat.success) {
    return { refreshToken: flat.data.refresh_token };
  }
  throw new Error('Refresh Token not found in keyring payload');
}

function readFileCredentials(): { refreshToken: string } {
  const directory = path.join(os.homedir(), '.gemini');
  try {
    return parseRefreshToken(
      fs.readFileSync(path.join(directory, 'antigravity-cli', 'antigravity-oauth-token'), 'utf8'),
    );
  } catch {
    // A missing or invalid CLI cache falls through to the flat OAuth cache.
  }
  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.join(directory, 'oauth_creds.json'), 'utf8'),
  );
  const credentials = RefreshTokenSchema.parse(parsed);
  return { refreshToken: credentials.refresh_token };
}

/** Search CLI, standalone, then flat OAuth credentials when Keychain is unavailable. */
function readMacOSIdeFilePayload(): string {
  const directory = path.join(os.homedir(), '.gemini');
  for (const file of [
    path.join(directory, 'antigravity-cli', 'antigravity-oauth-token'),
    path.join(directory, 'jetski-standalone-oauth-token'),
    path.join(directory, 'oauth_creds.json'),
  ]) {
    try {
      const payload = fs.readFileSync(file, 'utf8');
      parseRefreshToken(payload);
      return payload;
    } catch {
      // Try the next credential file when this candidate is unavailable or malformed.
    }
  }
  throw new Error('No credential found in macOS IDE credential files');
}

export function readMacOSIdeCredentialPayload(): string {
  return readMacOSKeychainPayload(true, true);
}

export function readMacOSCredentialStore(allowFileFallback: boolean): { refreshToken: string } {
  return parseRefreshToken(readMacOSKeychainPayload(allowFileFallback, false));
}

function readMacOSKeychainPayload(allowFileFallback: boolean, ide: boolean): string {
  const result = spawnSync('security', [
    'find-generic-password',
    '-s',
    'gemini',
    '-a',
    'antigravity',
    '-w',
  ]);
  if (result.error) {
    throw new Error('Failed to execute security command');
  }
  if (result.status !== 0) {
    if (allowFileFallback) {
      try {
        return ide
          ? readMacOSIdeFilePayload()
          : JSON.stringify({ refresh_token: readFileCredentials().refreshToken });
      } catch {
        // Only a successfully parsed file can replace a failed Keychain lookup.
      }
    }
    throw new Error('No credential found in macOS Keychain');
  }
  const secret = result.stdout.toString('utf8').trim();
  const payload = secret.startsWith('go-keyring-base64:')
    ? new TextDecoder('utf8', { fatal: true }).decode(
        decodeMacOSCredentialBase64(secret.slice('go-keyring-base64:'.length)),
      )
    : secret;
  return payload;
}

export function writeMacOSCredentialStore(token: CredentialStoreTokenInput): void {
  const payload = JSON.stringify(buildMacOSCredentialPayload(token));
  writeMacOSKeychainPayload(payload);
}

/** Replace the Keychain item with a go-keyring Base64 value using -w and -A. */
export function writeMacOSKeychainPayload(payload: string): void {
  const value = `go-keyring-base64:${Buffer.from(payload, 'utf8').toString('base64')}`;
  spawnSync('security', ['delete-generic-password', '-s', 'gemini', '-a', 'antigravity']);
  const result = spawnSync('security', [
    'add-generic-password',
    '-s',
    'gemini',
    '-a',
    'antigravity',
    '-w',
    value,
    '-A',
  ]);
  if (result.error) {
    throw new Error('Failed to execute security command');
  }
  if (result.status !== 0) {
    throw new Error(
      `macOS security command failed: ${redactDiagnosticText(result.stderr.toString('utf8').trim())}`,
    );
  }
}

function setPrivatePermissions(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // File installation remains successful when chmod is unavailable.
  }
}

/** Install the three local caches after a successful Keychain write. */
export function syncMacOSCredentialFiles(credentials: ClientAccountCredentials): void {
  const directory = path.join(os.homedir(), '.gemini');
  fs.mkdirSync(directory, { recursive: true });
  const cliDirectory = path.join(directory, 'antigravity-cli');
  try {
    fs.mkdirSync(cliDirectory, { recursive: true });
  } catch {
    logger.warn('Failed to create Antigravity CLI credential directory');
  }
  const cliFile = path.join(cliDirectory, 'antigravity-oauth-token');
  try {
    fs.writeFileSync(
      cliFile,
      JSON.stringify(buildMacOSCredentialPayload(credentials.token), null, 2),
    );
    setPrivatePermissions(cliFile);
  } catch {
    logger.warn('Failed to write Antigravity CLI credential file');
  }
  writeMacOSOAuthFiles(credentials);
}

/** Encode IDE token fields with account email and an optional root-level ID token. */
export function buildMacOSIdeCredentialPayload(credentials: ClientAccountCredentials): string {
  const payload = buildMacOSCredentialPayload(credentials.token);
  return JSON.stringify({
    token: { ...payload.token, expires_in: 3599 },
    auth_method: payload.auth_method,
    id_token_email: credentials.email,
    ...(credentials.token.id_token !== undefined ? { id_token: credentials.token.id_token } : {}),
  });
}

/** IDE switches mirror standalone and Google caches, leaving the dedicated Agy session alone. */
export function syncMacOSIdeCredentialFiles(
  credentials: ClientAccountCredentials,
  payload: string,
): void {
  try {
    writeIdeStandaloneCredentialPayload(payload);
  } catch {
    logger.warn('Failed to write macOS IDE standalone credential file');
  }
  writeMacOSOAuthFiles(credentials);
}

function writeMacOSOAuthFiles(credentials: ClientAccountCredentials): void {
  const directory = path.join(os.homedir(), '.gemini');
  fs.mkdirSync(directory, { recursive: true });
  const token = credentials.token;
  const oauthFile = path.join(directory, 'oauth_creds.json');
  fs.writeFileSync(
    oauthFile,
    JSON.stringify(
      {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        token_type: 'Bearer',
        expiry_date:
          token.expiry_timestamp > 10_000_000_000
            ? token.expiry_timestamp
            : token.expiry_timestamp * 1000,
        ...(token.id_token !== undefined ? { id_token: token.id_token } : {}),
        scope: OAUTH_SCOPE,
      },
      null,
      2,
    ),
  );
  setPrivatePermissions(oauthFile);
  const accountsFile = path.join(directory, 'google_accounts.json');
  try {
    fs.writeFileSync(accountsFile, JSON.stringify({ active: credentials.email, old: [] }, null, 2));
  } catch {
    // The OAuth cache is already installed; account-list mirroring is best effort.
  }
  setPrivatePermissions(accountsFile);
}
