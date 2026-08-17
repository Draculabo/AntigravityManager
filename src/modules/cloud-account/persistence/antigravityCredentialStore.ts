import { Entry } from '@napi-rs/keyring';
import { execFileSync, spawnSync } from 'child_process';
import { z } from 'zod';
import { logger } from '@/shared/logging/logger';

export interface CredentialStoreTokenInput {
  access_token: string;
  refresh_token: string;
  expiry_timestamp: number;
}

export interface CredentialStoreToken {
  accessToken?: string;
  refreshToken: string;
  idToken?: string;
  projectId?: string;
  expiryTimestamp?: number;
}

export type CredentialStoreReadErrorCode =
  | 'permission-denied'
  | 'locked'
  | 'malformed'
  | 'timed-out'
  | 'unavailable';

const CREDENTIAL_STORE_READ_ERROR_MESSAGES: Record<CredentialStoreReadErrorCode, string> = {
  'permission-denied': 'Permission was denied while reading the Antigravity credential store.',
  locked: 'The Antigravity credential store is locked.',
  malformed: 'The Antigravity credential payload is malformed.',
  'timed-out': 'Timed out while reading the Antigravity credential store.',
  unavailable: 'The Antigravity credential store is unavailable.',
};

export class CredentialStoreReadError extends Error {
  constructor(readonly code: CredentialStoreReadErrorCode) {
    super(CREDENTIAL_STORE_READ_ERROR_MESSAGES[code]);
    this.name = 'CredentialStoreReadError';
  }
}

const CredentialTokenPayloadSchema = z
  .object({
    access_token: z.string().trim().min(1).optional(),
    refresh_token: z.string().trim().min(1),
    id_token: z.string().trim().min(1).optional(),
    project_id: z.string().trim().min(1).optional(),
    expiry_timestamp: z.number().finite().optional(),
    expiry: z.string().trim().min(1).optional(),
  })
  .passthrough();

const NestedCredentialPayloadSchema = z
  .object({
    token: CredentialTokenPayloadSchema,
  })
  .passthrough();

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

function decodeCredentialStoreText(secret: Uint8Array): string {
  let payload: string;
  try {
    payload = new TextDecoder('utf-8', { fatal: true }).decode(secret).trim();
  } catch {
    throw new CredentialStoreReadError('malformed');
  }

  if (!payload.startsWith('go-keyring-base64:')) {
    return payload;
  }

  try {
    const encodedPayload = payload.slice('go-keyring-base64:'.length);
    return new TextDecoder('utf-8', { fatal: true })
      .decode(Buffer.from(encodedPayload, 'base64'))
      .trim();
  } catch {
    throw new CredentialStoreReadError('malformed');
  }
}

function parseCredentialStorePayload(payload: string): CredentialStoreToken {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(payload);
  } catch {
    throw new CredentialStoreReadError('malformed');
  }

  const nestedPayload = NestedCredentialPayloadSchema.safeParse(parsedJson);
  let token: z.infer<typeof CredentialTokenPayloadSchema>;
  if (nestedPayload.success) {
    token = nestedPayload.data.token;
  } else {
    const topLevelPayload = CredentialTokenPayloadSchema.safeParse(parsedJson);
    if (!topLevelPayload.success) {
      throw new CredentialStoreReadError('malformed');
    }
    token = topLevelPayload.data;
  }

  let expiryTimestamp = token.expiry_timestamp;
  if (expiryTimestamp === undefined && token.expiry) {
    const parsedExpiry = Date.parse(token.expiry);
    if (Number.isFinite(parsedExpiry)) {
      expiryTimestamp = Math.floor(parsedExpiry / 1000);
    }
  }

  return {
    refreshToken: token.refresh_token,
    ...(token.access_token ? { accessToken: token.access_token } : {}),
    ...(token.id_token ? { idToken: token.id_token } : {}),
    ...(token.project_id ? { projectId: token.project_id } : {}),
    ...(expiryTimestamp !== undefined ? { expiryTimestamp } : {}),
  };
}

function classifyCredentialStoreReadError(error: unknown): CredentialStoreReadError {
  if (error instanceof CredentialStoreReadError) {
    return error;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code.toLowerCase()
      : '';

  if (code === 'etimedout' || message.includes('timed out')) {
    return new CredentialStoreReadError('timed-out');
  }
  if (
    code === 'eacces' ||
    code === 'eperm' ||
    message.includes('permission denied') ||
    message.includes('access denied')
  ) {
    return new CredentialStoreReadError('permission-denied');
  }
  if (message.includes('locked')) {
    return new CredentialStoreReadError('locked');
  }
  return new CredentialStoreReadError('unavailable');
}

function readViaNativeKeyring(): Uint8Array | null {
  const entry = Entry.withTarget('gemini:antigravity', 'gemini', 'antigravity');
  const secret = entry.getSecret();
  return secret ? Uint8Array.from(secret) : null;
}

function readViaSecretTool(): Uint8Array | null {
  const lookupResult = spawnSync(
    'secret-tool',
    ['lookup', 'service', 'gemini', 'username', 'antigravity'],
    {
      encoding: 'utf-8',
      timeout: 10_000,
    },
  );
  if (lookupResult.error) {
    throw classifyCredentialStoreReadError(lookupResult.error);
  }
  if (lookupResult.status !== 0) {
    const stderr = lookupResult.stderr?.toLowerCase() ?? '';
    if (stderr.includes('permission denied') || stderr.includes('access denied')) {
      throw new CredentialStoreReadError('permission-denied');
    }
    if (stderr.includes('locked')) {
      throw new CredentialStoreReadError('locked');
    }
    return null;
  }

  const payload = lookupResult.stdout?.trim();
  return payload ? Buffer.from(payload, 'utf-8') : null;
}

export function readAntigravityCredentialStoreToken(): CredentialStoreToken | null {
  let nativeReadError: unknown;
  try {
    const secret = readViaNativeKeyring();
    if (secret) {
      return parseCredentialStorePayload(decodeCredentialStoreText(secret));
    }
  } catch (error) {
    nativeReadError = error;
  }

  if (process.platform === 'linux') {
    try {
      const secret = readViaSecretTool();
      if (secret) {
        return parseCredentialStorePayload(decodeCredentialStoreText(secret));
      }
      if (nativeReadError) {
        throw classifyCredentialStoreReadError(nativeReadError);
      }
      return null;
    } catch (error) {
      throw classifyCredentialStoreReadError(error);
    }
  }

  if (nativeReadError) {
    throw classifyCredentialStoreReadError(nativeReadError);
  }
  return null;
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
    execFileSync(
      'security',
      ['add-generic-password', '-s', 'gemini', '-a', 'antigravity', '-A', '-U', '-w'],
      {
        input: `${value}\n`,
        encoding: 'utf-8',
        stdio: ['pipe', 'ignore', 'ignore'],
      },
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