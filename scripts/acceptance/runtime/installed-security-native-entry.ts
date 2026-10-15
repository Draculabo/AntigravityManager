import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getAgentDir } from '../../../src/shared/platform/paths';
import {
  decryptWithMigration,
  encrypt,
  initializeMasterKey,
} from '../../../src/shared/security/security';

// The launcher redirects every keyring call to its unique synthetic service.
async function check() {
  const phase = process.argv[2];
  assert(phase === 'write' || phase === 'reopen');
  const file = path.join(getAgentDir(), 'security-probe.txt');
  const plaintext = 'isolated-native-security-probe';
  if (phase === 'write') {
    await initializeMasterKey({ encryptedSamples: [], storedAccountCount: 0 });
    const encrypted = await encrypt(plaintext);
    assert.notEqual(encrypted, plaintext);
    assert.equal((await decryptWithMigration(encrypted)).value, plaintext);
    await writeFile(file, encrypted);
  } else {
    const encrypted = await readFile(file, 'utf8');
    await initializeMasterKey({ encryptedSamples: [encrypted], storedAccountCount: 0 });
    assert.equal((await decryptWithMigration(encrypted)).value, plaintext);
  }
  process.stdout.write(`Installed security ${phase} passed.\n`);
}

check().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
