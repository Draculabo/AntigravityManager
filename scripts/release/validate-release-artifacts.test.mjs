import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';
import { validateReleaseArtifacts } from './validate-release-artifacts.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agm-release-assets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'merged');
  const names = [
    'wix/x64/Antigravity.Manager_0.28.0_x64_en-US.msi',
    ...['x64', 'arm64'].flatMap((arch) => [
      `squirrel.windows/${arch}/Antigravity.Manager-0.28.0-win32-${arch}-setup.exe`,
      `squirrel.windows/${arch}/antigravity_manager-0.28.0-${arch}-full.nupkg`,
      `squirrel.windows/${arch}/RELEASES`,
      `nsis/${arch}/Antigravity.Manager-0.28.0-windows-${arch}-nsis.exe`,
      `nsis/${arch}/latest-nsis-${arch}.yml`,
      `Antigravity.Manager_0.28.0_${arch}.dmg`,
      `zip/darwin/${arch}/Antigravity.Manager_0.28.0_${arch}.zip`,
    ]),
    'deb/x64/Antigravity.Manager_0.28.0_amd64.deb',
    'deb/arm64/Antigravity.Manager_0.28.0_arm64.deb',
    'Antigravity.Manager_0.28.0_amd64.AppImage',
    'Antigravity.Manager_0.28.0_aarch64.AppImage',
    'rpm/x64/Antigravity.Manager-0.28.0-1.x86_64.rpm',
    'rpm/arm64/Antigravity.Manager-0.28.0-1.aarch64.rpm',
    'sha256sums-linux-amd64.txt',
    'sha256sums-linux-aarch64.txt',
  ];
  for (const name of names) {
    const file = path.join(sourceDir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'fixture');
  }
  const inventoryFile = path.join(root, 'inventory.json');
  const artifacts = [
    'make-win32-x64',
    'make-win32-arm64',
    'make-darwin-x64',
    'make-darwin-arm64',
    'make-linux-x64',
    'make-linux-arm64',
  ].map((name) => ({ name, expired: false }));
  writeFileSync(inventoryFile, JSON.stringify([{ artifacts }]));
  return { root, sourceDir, inventoryFile, artifacts, names: names.sort() };
}

test('accepts all six artifacts across inventory pages and returns the merged file list', (t) => {
  const input = fixture(t);
  writeFileSync(
    input.inventoryFile,
    JSON.stringify([
      { artifacts: input.artifacts.slice(0, 3) },
      { artifacts: [...input.artifacts.slice(3), { name: 'diagnostics', expired: false }] },
    ]),
  );
  assert.deepEqual(validateReleaseArtifacts(input), input.names);
});

for (const [label, transform] of [
  ['missing target', (artifacts) => artifacts.slice(1)],
  ['duplicate target', (artifacts) => [...artifacts, artifacts[0]]],
  ['unexpected target', (artifacts) => [...artifacts, { name: 'make-linux-ia32', expired: false }]],
  ['expired target', (artifacts) => [{ ...artifacts[0], expired: true }, ...artifacts.slice(1)]],
]) {
  test(`rejects ${label} in the inventory even when merged files are complete`, (t) => {
    const input = fixture(t);
    writeFileSync(input.inventoryFile, JSON.stringify([{ artifacts: transform(input.artifacts) }]));
    assert.throws(() => validateReleaseArtifacts(input), /build artifacts|expired artifacts/);
  });
}

test('rejects an invalid artifact inventory boundary', (t) => {
  const input = fixture(t);
  writeFileSync(input.inventoryFile, JSON.stringify([{ artifacts: [{ name: 'make-linux-x64' }] }]));
  assert.throws(() => validateReleaseArtifacts(input), /expired/);
});

for (const [name, label] of [
  ['Antigravity.Manager_0.28.0_arm64.dmg', 'macOS arm64 dmg'],
  ['zip/darwin/x64/Antigravity.Manager_0.28.0_x64.zip', 'macOS x64 zip'],
  ['deb/arm64/Antigravity.Manager_0.28.0_arm64.deb', 'Linux arm64 DEB'],
  ['sha256sums-linux-aarch64.txt', 'Linux aarch64 checksums'],
  ['nsis/arm64/latest-nsis-arm64.yml', 'Windows arm64 NSIS metadata'],
  ['squirrel.windows/x64/RELEASES', 'Windows x64 RELEASES'],
]) {
  test(`rejects missing ${label} despite other installable assets`, (t) => {
    const input = fixture(t);
    rmSync(path.join(input.sourceDir, name));
    assert.throws(
      () => validateReleaseArtifacts(input),
      (error) => error.message.includes(label),
    );
  });
}

test('an empty installer cannot satisfy a required asset', (t) => {
  const input = fixture(t);
  writeFileSync(
    path.join(
      input.sourceDir,
      'squirrel.windows/x64/Antigravity.Manager-0.28.0-win32-x64-setup.exe',
    ),
    '',
  );
  assert.throws(() => validateReleaseArtifacts(input), /Windows x64 setup/);
});

test('the actual CLI accepts complete downloads and rejects an incomplete download', (t) => {
  const input = fixture(t);
  const entry = fileURLToPath(new URL('./validate-release-artifacts.mjs', import.meta.url));
  const args = [entry, '--source', input.sourceDir, '--inventory', input.inventoryFile];
  const options = { encoding: 'utf8', timeout: 10_000, maxBuffer: 16_384, windowsHide: true };
  const valid = spawnSync(process.execPath, args, options);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Validated 23 nonempty release asset files across six build targets/);
  rmSync(path.join(input.sourceDir, 'Antigravity.Manager_0.28.0_arm64.dmg'));
  const invalid = spawnSync(process.execPath, args, options);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Missing nonempty release assets: macOS arm64 dmg/);
});

test('dry-run verification is read-only and gates publication before release writes', () => {
  const workflow = YAML.parse(
    readFileSync(new URL('../../.github/workflows/publish.yaml', import.meta.url), 'utf8'),
  );
  const verify = workflow.jobs['verify-artifacts'];
  assert.equal(verify.if, undefined, 'Verification must also run on dry runs');
  assert.equal(verify.environment, undefined);
  assert.deepEqual(verify.permissions, { contents: 'read', actions: 'read' });
  assert(verify.steps.some((step) => step.run?.includes('test:acceptance release artifacts')));
  assert(
    verify.steps.some((step) => step.run?.includes('node scripts/prepare-windows-update-feed.mjs')),
  );
  assert(!verify.steps.some((step) => /gh release (create|upload)|git push/.test(step.run ?? '')));
  const official = YAML.parse(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );
  const publish = official.jobs.publish;
  const migrationInput = official.on.workflow_dispatch.inputs.migration_version;
  const plan = official.jobs.plan.steps.find((step) => step.id === 'candidate');
  assert.deepEqual(
    { type: migrationInput.type, required: migrationInput.required },
    { type: 'string', required: false },
  );
  assert.equal(plan.env.RELEASE_MIGRATION_VERSION, '${{ inputs.migration_version }}');
  assert.equal(official.jobs.package.uses, './.github/workflows/publish.yaml');
  assert.equal(official.jobs.package.with.source_sha, '${{ needs.plan.outputs.source }}');
  assert.equal(publish.steps[0].with.ref, '${{ github.sha }}');
  assert.equal(
    publish.steps.find((step) => step.run?.includes('manage-release.mjs record')).id,
    'draft',
  );
  assert.equal(
    publish.steps.find((step) => step.run?.includes('deliver-release-assets.mjs publish')).env
      .RELEASE_ID,
    '${{ steps.draft.outputs.release_id }}',
  );
  assert.deepEqual(verify.needs, ['resolve', 'build']);
  assert.deepEqual(publish.needs, ['plan', 'package']);
  assert.equal(publish.environment, 'release');
  assert.equal(publish.if, '!inputs.dry_run');
  assert.deepEqual(workflow.on.release.types, ['published']);
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
  assert(workflow.jobs['attach-assets'].needs.includes('verify-artifacts'));
  assert.equal(
    workflow.jobs['attach-assets'].if,
    "needs.resolve.outputs.mode == 'event' || needs.resolve.outputs.mode == 'manual'",
  );
  const validation = publish.steps.findIndex((step) =>
    step.run?.includes('test:acceptance release artifacts'),
  );
  const releaseWrite = publish.steps.findIndex((step) =>
    step.run?.includes('manage-release.mjs record'),
  );
  const publication = publish.steps.findIndex((step) =>
    step.run?.includes('deliver-release-assets.mjs publish'),
  );
  assert(validation >= 0 && validation < releaseWrite && releaseWrite < publication);
});
