import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loginSettings } from '../helpers/windows-login-settings.mjs';

assert.equal(process.platform, 'win32');
assert(
  process.argv.length === 3 || process.argv.length === 4,
  'Supply current MSI and optional previous MSI',
);
const msi = await realpath(path.resolve(process.argv[2]));
assert.equal(path.extname(msi), '.msi');
const parent = await realpath(os.tmpdir());
const directory = await mkdtemp(path.join(parent, 'agm-installed-msi-'));
const target = path.join(directory, 'application');
const backup = path.join(directory, 'login-settings.json');
const environment = { ...process.env, AGM_ACCEPTANCE_MSI: msi };
function run(executable, args, timeout = 300_000) {
  const result = spawnSync(executable, args, {
    env: environment,
    cwd: process.cwd(),
    windowsHide: true,
    encoding: 'utf8',
    timeout,
    maxBuffer: 16_000,
  });
  if (result.error) {
    throw result.error;
  }
  assert.equal(result.status, 0, `${executable} failed: ${(result.stderr ?? '').slice(-4000)}`);
  return result.stdout ?? '';
}
function inspectInstaller(file) {
  environment.AGM_ACCEPTANCE_MSI = file;
  return JSON.parse(
    run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase($env:AGM_ACCEPTANCE_MSI, 0)
$values = @{}
foreach ($property in @('ProductCode', 'ProductName', 'ProductVersion', 'UpgradeCode')) {
  $view = $database.OpenView("SELECT Value FROM Property WHERE Property = '$property'")
  $view.Execute()
  $values[$property] = $view.Fetch().StringData(1)
  $view.Close()
}
$values['state'] = $installer.ProductState($values['ProductCode'])
$values['family'] = @($installer.RelatedProducts($values['UpgradeCode']))
$values['platform'] = $database.SummaryInformation(0).Property(7)
$values['desktop'] = [Environment]::GetFolderPath('Desktop')
$values['programs'] = [Environment]::GetFolderPath('Programs')
$values | ConvertTo-Json -Compress
`,
    ]),
  );
}
const properties = inspectInstaller(msi);
function existingSquirrelInstallation() {
  return run('powershell.exe', [
    '-NoProfile',
    '-Command',
    `
$entry = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\antigravity_manager' -ErrorAction SilentlyContinue
if ($entry) { $entry | Select-Object DisplayVersion, InstallLocation, UninstallString | ConvertTo-Json -Compress }
`,
  ]).trim();
}
const existingInstallation = existingSquirrelInstallation();
assert.match(properties.ProductCode, /^\{[A-F0-9-]+\}$/i);
assert.match(properties.ProductName, /^Antigravity Manager \(Machine - MSI\)$/);
assert.equal(properties.state, -1, 'Refuse to replace a registered MSI product');
assert.deepEqual(
  properties.family,
  [],
  'Refuse to replace any existing product in this MSI family',
);
assert.match(properties.platform, /^x64;/);
const previousMsi = process.argv[3] ? await realpath(path.resolve(process.argv[3])) : null;
const previous = previousMsi ? inspectInstaller(previousMsi) : null;
if (previous) {
  assert.equal(previous.UpgradeCode, properties.UpgradeCode);
  assert.notEqual(previous.ProductCode, properties.ProductCode);
  assert.equal(previous.state, -1);
  assert.deepEqual(previous.family, []);
  assert.match(previous.platform, /^x64;/);
  assert(
    previous.ProductVersion.localeCompare(properties.ProductVersion, undefined, { numeric: true }) <
      0,
  );
}
const version = properties.ProductVersion.split('.').slice(0, 3).join('.');
const executable = path.join(target, `app-${version}`, 'antigravity-manager.exe');
const resources = path.join(path.dirname(executable), 'resources', 'standalone');
const shortcuts = [
  path.join(properties.desktop, 'Antigravity Manager.lnk'),
  path.join(properties.programs, 'Draculabo', 'Antigravity Manager.lnk'),
];
const savedShortcuts = new Map();
for (const file of shortcuts) {
  try {
    savedShortcuts.set(file, await readFile(file));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    savedShortcuts.set(file, null);
  }
}
await writeFile(backup, loginSettings('snapshot', backup));
let installationAttempted = false;
let complete = false;
let acceptanceError;
let recoveryError;
function install(file, log) {
  run('msiexec.exe', [
    '/i',
    file,
    '/qn',
    '/norestart',
    '/l*v',
    path.join(directory, log),
    `APPLICATIONROOTDIRECTORY=${target}`,
    'ALLUSERS=2',
    'MSIINSTALLPERUSER=1',
    'INSTALLLEVEL=1',
    'AUTOUPDATEENABLED=0',
  ]);
}
try {
  installationAttempted = true;
  // WiX removes the old application directory during upgrade; real profiles live outside it.
  const profile = path.join(directory, 'profile');
  const marker = path.join(profile, 'acceptance-profile-marker.txt');
  if (previous) {
    install(previousMsi, 'previous-install.log');
    assert.equal(inspectInstaller(previousMsi).state, 5);
    await mkdir(profile);
    await writeFile(marker, 'Installer must preserve non-package profile files.');
  }
  install(msi, 'install.log');
  assert.equal(inspectInstaller(msi).state, 5);
  if (previous) {
    assert.equal(
      inspectInstaller(previousMsi).state,
      -1,
      'Major upgrade must unregister the old product',
    );
    assert.deepEqual(inspectInstaller(msi).family, [properties.ProductCode]);
    assert.equal(
      await readFile(marker, 'utf8'),
      'Installer must preserve non-package profile files.',
    );
    console.log(
      'Same-family x64 MSI major upgrade removed the previous product and preserved the external profile fixture.',
    );
  }
  assert((await stat(executable)).isFile());
  assert.equal(await realpath(target), target);
  console.log('Actual MSI installation into the isolated host directory passed.');
  const worker = path.join(resources, 'core', 'thought-store.worker.js');
  const workerDigest = createHash('sha256')
    .update(await readFile(worker))
    .digest('hex');
  assert((await realpath(worker)).startsWith(`${target}${path.sep}`));
  await rm(worker);
  run('msiexec.exe', [
    '/fa',
    properties.ProductCode,
    '/qn',
    '/norestart',
    '/l*v',
    path.join(directory, 'repair.log'),
  ]);
  assert.equal(
    createHash('sha256')
      .update(await readFile(worker))
      .digest('hex'),
    workerDigest,
  );
  console.log('Windows Installer repair restored the missing standalone worker exactly.');
  process.stdout.write(
    run(process.execPath, ['scripts/acceptance/runtime/installed-runtime-native.mjs', resources]),
  );
  process.stdout.write(
    run(process.execPath, ['scripts/acceptance/runtime/packaged-desktop-native.mjs', executable]),
  );
  complete = true;
} catch (error) {
  acceptanceError = error;
}
try {
  let cleanupError;
  if (installationAttempted) {
    // Uninstall only this package's verified product identity, never a name-based existing install.
    for (const identity of [properties.ProductCode, ...(previous ? [previous.ProductCode] : [])]) {
      const result = spawnSync(
        'msiexec.exe',
        ['/x', identity, '/qn', '/norestart', '/l*v', path.join(directory, 'uninstall.log')],
        { windowsHide: true, timeout: 180_000, encoding: 'utf8', maxBuffer: 4000 },
      );
      if (result.error || (result.status !== 0 && result.status !== 1605)) {
        cleanupError = new Error(`MSI cleanup failed; recovery files: ${directory}`);
      }
    }
    if (
      inspectInstaller(msi).state !== -1 ||
      (previous && inspectInstaller(previousMsi).state !== -1)
    ) {
      cleanupError = new Error(`MSI product remains registered; recovery files: ${directory}`);
    }
  }
  for (const [file, content] of savedShortcuts) {
    if (content === null) {
      await rm(file, { force: true });
    } else {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      assert.deepEqual(await readFile(file), content);
    }
  }
  loginSettings('restore', backup);
  assert.equal(loginSettings('snapshot', backup), (await readFile(backup, 'utf8')).trim());
  assert.equal(
    existingSquirrelInstallation(),
    existingInstallation,
    'Preserve the existing Squirrel installation',
  );
  if (cleanupError) {
    throw cleanupError;
  }
  console.log('Test MSI uninstalled; previous shortcuts and application login settings restored.');
  if (complete) {
    assert.equal(path.dirname(await realpath(directory)), parent);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } else {
    console.error(`Acceptance failed; isolated installer diagnostics retained: ${directory}`);
  }
} catch (error) {
  recoveryError = error;
}
if (acceptanceError || recoveryError) {
  throw new AggregateError(
    [acceptanceError, recoveryError].filter(Boolean),
    `MSI acceptance or recovery failed; diagnostics: ${directory}`,
  );
}
