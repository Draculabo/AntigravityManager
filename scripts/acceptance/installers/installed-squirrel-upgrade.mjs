import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, openSync } from 'node:fs';
import { mkdir, readFile, realpath, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { loginSettings } from '../helpers/windows-login-settings.mjs';
import { squirrelRegistration } from '../helpers/windows-squirrel-registration.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.argv.length, 5, 'Supply authentic installation, isolated copy, and new feed');
const source = await realpath(path.resolve(process.argv[2]));
const fixture = await realpath(path.resolve(process.argv[3]));
const feed = await realpath(path.resolve(process.argv[4]));
const temporaryParent = await realpath(os.tmpdir());
assert.equal(path.dirname(path.dirname(fixture)), temporaryParent);
assert.equal(path.basename(fixture), 'antigravity_manager');
assert.notEqual(source, fixture);
assert.equal(
  (await stat(path.join(fixture, 'packages', 'antigravity_manager-0.19.0-full.nupkg'))).isFile(),
  true,
);
assert.equal((await stat(path.join(feed, 'antigravity_manager-0.21.1-full.nupkg'))).isFile(), true);
const diagnosticRoot = path.dirname(fixture);
const loginBackup = path.join(diagnosticRoot, 'login-settings.json');
const registryBackup = path.join(diagnosticRoot, 'squirrel-registration.json');
const externalProfile = path.join(diagnosticRoot, 'profile');
const marker = path.join(externalProfile, 'retained-marker.txt');

async function digest(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

function runNode(script, argument) {
  const result = spawnSync(process.execPath, [script, argument], {
    cwd: process.cwd(),
    windowsHide: true,
    timeout: 300_000,
    encoding: 'utf8',
    maxBuffer: 16_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${script} failed: ${(result.stderr ?? '').slice(-2500)}`);
  process.stdout.write(result.stdout ?? '');
}

const sourceFiles = [
  'Update.exe',
  'packages/antigravity_manager-0.19.0-full.nupkg',
  'packages/RELEASES',
  'app-0.19.0/antigravity-manager.exe',
];
const sourceDigests = new Map();
for (const name of sourceFiles) {
  const original = await digest(path.join(source, name));
  assert.equal(
    await digest(path.join(fixture, name)),
    original,
    `Authentic copy mismatch: ${name}`,
  );
  sourceDigests.set(name, original);
}
assert.equal((await readdir(source)).includes('app-0.21.1'), false);
const desktop = path.join(os.homedir(), 'Desktop', 'Antigravity Manager.lnk');
const programs = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const shortcuts = [
  desktop,
  path.join(programs, 'Antigravity Manager.lnk'),
  path.join(programs, 'Draculabo', 'Antigravity Manager.lnk'),
];
const originalShortcuts = new Map();
for (const file of shortcuts) {
  try {
    originalShortcuts.set(file, await readFile(file));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    originalShortcuts.set(file, null);
  }
}
await writeFile(loginBackup, loginSettings('snapshot', loginBackup));
await writeFile(registryBackup, squirrelRegistration('snapshot'));
await mkdir(externalProfile);
await writeFile(marker, 'External profile survives Squirrel binary upgrade.');
let acceptanceError;
let recoveryError;
let complete = false;
try {
  const updateLog = path.join(diagnosticRoot, 'squirrel-update.log');
  const updateLogFile = openSync(updateLog, 'w');
  let result;
  try {
    result = spawnSync(path.join(fixture, 'Update.exe'), [`--update=${feed}`], {
      cwd: fixture,
      windowsHide: true,
      timeout: 300_000,
      stdio: ['ignore', updateLogFile, updateLogFile],
      env: { ...process.env, HOME: externalProfile, USERPROFILE: externalProfile },
    });
  } finally {
    closeSync(updateLogFile);
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Squirrel update failed; inspect ${updateLog}`);
  const updated = path.join(fixture, 'app-0.21.1', 'antigravity-manager.exe');
  assert((await stat(updated)).isFile());
  assert(
    (
      await stat(path.join(fixture, 'app-0.21.1', 'resources', 'standalone', 'node', 'node.exe'))
    ).isFile(),
  );
  assert.equal(
    await readFile(marker, 'utf8'),
    'External profile survives Squirrel binary upgrade.',
  );
  for (const [name, original] of sourceDigests) {
    assert.equal(
      await digest(path.join(source, name)),
      original,
      `Existing installation changed: ${name}`,
    );
  }
  assert.equal((await readdir(source)).includes('app-0.21.1'), false);
  console.log(
    'Authentic 0.19.0 Squirrel copy upgraded to the traced 0.21.1 package; host installation unchanged.',
  );
  runNode(
    'scripts/acceptance/runtime/installed-runtime-native.mjs',
    path.join(fixture, 'app-0.21.1', 'resources', 'standalone'),
  );
  runNode('scripts/acceptance/runtime/packaged-desktop-native.mjs', updated);
  complete = true;
} catch (error) {
  acceptanceError = error;
}
try {
  const savedRegistration = await readFile(registryBackup, 'utf8');
  if (squirrelRegistration('snapshot') !== savedRegistration) {
    squirrelRegistration('restore', savedRegistration);
  }
  assert.equal(squirrelRegistration('snapshot'), savedRegistration);
  loginSettings('restore', loginBackup);
  assert.equal(
    loginSettings('snapshot', loginBackup),
    (await readFile(loginBackup, 'utf8')).trim(),
  );
  for (const [file, bytes] of originalShortcuts) {
    if (bytes === null) {
      await rm(file, { force: true });
    } else {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      assert.deepEqual(await readFile(file), bytes);
    }
  }
  if (complete) {
    assert.equal(path.dirname(await realpath(diagnosticRoot)), temporaryParent);
    await rm(diagnosticRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
} catch (error) {
  recoveryError = error;
}
if (acceptanceError || recoveryError) {
  throw new AggregateError(
    [acceptanceError, recoveryError].filter(Boolean),
    `Squirrel acceptance/recovery failed; diagnostics: ${diagnosticRoot}`,
  );
}
console.log(
  'Squirrel update fixture removed; application shortcuts, startup settings and uninstall registration restored.',
);
