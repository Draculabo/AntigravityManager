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
  try {
    spawnSync('secret-tool', ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function writeViaSecretTool(payload: string): void {
  const result = spawnSync(
    'secret-tool',
    ['store', '--label=gemini', 'service', 'gemini', 'username', 'antigravity'],
    { input: payload, encoding: 'utf-8' },
  );

  if (result.status !== 0) {
    throw new Error(
      `Linux secret-tool failed: ${result.stderr || result.error?.message || 'unknown error'}`,
    );
  }
}

function writeViaPythonSecretStorage(payload: string): void {
  const pythonScript = `
import sys
try:
    data = sys.stdin.read()
    import secretstorage
    bus = secretstorage.dbus_init()
    collection = secretstorage.get_default_collection(bus)
    if collection.is_locked():
        collection.unlock()
    if collection.is_locked():
        raise Exception('Failed to unlock default keyring collection')
    # Delete existing
    items = list(collection.search_items({'service': 'gemini', 'username': 'antigravity'}))
    for item in items:
        item.delete()
    # Store new
    collection.create_item(
        'gemini',
        {'service': 'gemini', 'username': 'antigravity'},
        data.encode('utf-8'),
        replace=True
    )
    print('OK:secretstorage')
except ImportError:
    try:
        import gi
        gi.require_version('Secret', '1')
        from gi.repository import Secret
        schema = Secret.Schema.new(
            'org.gnome.keyring.NetworkPassword',
            Secret.SchemaFlags.NONE,
            {'service': Secret.SchemaAttributeType.STRING,
             'username': Secret.SchemaAttributeType.STRING}
        )
        Secret.password_store_sync(
            schema,
            {'service': 'gemini', 'username': 'antigravity'},
            Secret.COLLECTION_DEFAULT,
            'gemini',
            data,
            None
        )
        print('OK:gi.Secret')
    except Exception as e:
        print(f'FAIL:{e}', file=sys.stderr)
        sys.exit(1)
except Exception as e:
    print(f'FAIL:{e}', file=sys.stderr)
    sys.exit(1)
`;

  const result = spawnSync('python3', ['-c', pythonScript], {
    input: payload,
    encoding: 'utf-8',
    timeout: 10000,
  });

  if (result.status !== 0) {
    throw new Error(
      `Python credential store write failed: ${result.stderr || result.error?.message || 'unknown error'}`,
    );
  }

  logger.info(`Credential store written via Python: ${result.stdout.trim()}`);
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

  if (process.platform === 'win32') {
    const entry = Entry.withTarget('gemini:antigravity', 'gemini', 'antigravity');
    try {
      entry.deleteCredential();
    } catch {
      // Missing previous credential is acceptable.
    }

    entry.setSecret(Buffer.from(payload, 'utf-8'));
    return;
  }

  // Linux: try secret-tool first, then fall back to python3
  if (isSecretToolAvailable()) {
    writeViaSecretTool(payload);
    return;
  }

  logger.info('secret-tool not found, falling back to python3 secretstorage/gi.Secret');
  writeViaPythonSecretStorage(payload);
}
