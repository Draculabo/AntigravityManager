import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { prepareWindowsUpdateFeed } from '../../prepare-windows-update-feed.mjs';

const releaseTag = 'v0.21.1';
const repository = 'Draculabo/AntigravityManager';

test('release installs locked dependencies before verification and release writes', () => {
  const releaseWorkflow = YAML.parse(
    readFileSync(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );
  const publishWorkflow = YAML.parse(
    readFileSync(new URL('../../../.github/workflows/publish.yaml', import.meta.url), 'utf8'),
  );
  const packageSteps = releaseWorkflow.jobs.publish.steps;
  const verificationSteps = publishWorkflow.jobs['verify-artifacts'].steps;
  const installation = packageSteps.findIndex((step) =>
    /^pnpm install --frozen-lockfile\b/.test(step.run?.trim() ?? ''),
  );
  assert(installation >= 0, 'Release must install project dependencies before release writes');
  assert.match(packageSteps[installation].run, /--prod=false\b/);
  assert.match(packageSteps[installation].run, /--ignore-scripts\b/);
  const validation = packageSteps.findIndex((step) =>
    step.run?.includes('test:acceptance release artifacts'),
  );
  const record = packageSteps.findIndex((step) => step.run?.includes('manage-release.mjs record'));
  const publish = packageSteps.findIndex((step) =>
    step.run?.includes('deliver-release-assets.mjs publish'),
  );
  assert(validation > installation, 'Release must verify artifacts after dependency installation');
  assert(record > validation, 'Release metadata must be recorded after artifact verification');
  assert(publish > record, 'Release publication must follow candidate recording');
  assert(
    verificationSteps.some((step) => step.run?.includes('test:acceptance release artifacts')),
    'The reusable packaging workflow must verify the same downloaded artifacts',
  );
  assert.deepEqual(publishWorkflow.on.release.types, ['published']);
  assert.equal(publishWorkflow.jobs['update-distribution'], undefined);
  assert.deepEqual(releaseWorkflow.jobs['update-distribution'].needs, ['plan', 'publish']);
});

function makeFixture(root, corruptArch) {
  const sourceDir = path.join(root, 'source');
  for (const arch of ['x64', 'arm64']) {
    const archDir = path.join(sourceDir, arch);
    mkdirSync(archDir, { recursive: true });
    const squirrelName = `antigravity_manager-0.21.1-${arch}-full.nupkg`;
    const squirrelContents = Buffer.from(`squirrel-${arch}`);
    writeFileSync(path.join(archDir, squirrelName), squirrelContents);
    writeFileSync(
      path.join(archDir, 'RELEASES'),
      `${createHash('sha1').update(squirrelContents).digest('hex')} ${squirrelName} ${squirrelContents.length}\n`,
    );

    const nsisName = `Antigravity.Manager-0.21.1-windows-${arch}-nsis.exe`;
    const installer = Buffer.from(`nsis-${arch}`);
    writeFileSync(path.join(archDir, nsisName), installer);
    writeFileSync(
      path.join(archDir, `latest-nsis-${arch}.yml`),
      YAML.stringify({
        version: '0.21.1',
        files: [
          {
            url: nsisName,
            sha512:
              corruptArch === arch
                ? 'invalid'
                : createHash('sha512').update(installer).digest('base64'),
            size: installer.length,
          },
        ],
        path: nsisName,
        sha512: createHash('sha512').update(installer).digest('base64'),
      }),
    );
  }
  return sourceDir;
}

test('publishes architecture-specific Squirrel and verified NSIS feeds', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agm-update-feed-'));
  try {
    const sourceDir = makeFixture(root);
    const outputDir = path.join(root, 'output');
    prepareWindowsUpdateFeed({ releaseTag, repository, sourceDir, outputDir });

    for (const arch of ['x64', 'arm64']) {
      const squirrelFeed = readFileSync(path.join(outputDir, 'win32', arch, 'RELEASES'), 'utf8');
      assert.match(
        squirrelFeed,
        new RegExp(
          `releases/download/v0\\.21\\.1/antigravity_manager-0\\.21\\.1-${arch}-full\\.nupkg`,
        ),
      );

      const nsisFeed = YAML.parse(
        readFileSync(path.join(outputDir, 'nsis', 'win32', arch, 'latest.yml'), 'utf8'),
      );
      const expectedUrl = `https://github.com/${repository}/releases/download/${releaseTag}/Antigravity.Manager-0.21.1-windows-${arch}-nsis.exe`;
      assert.equal(nsisFeed.version, '0.21.1');
      assert.equal(nsisFeed.files[0].url, expectedUrl);
      assert.equal(nsisFeed.path, expectedUrl);
      assert.equal(
        nsisFeed.files[0].sha512,
        createHash('sha512')
          .update(Buffer.from(`nsis-${arch}`))
          .digest('base64'),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects NSIS metadata that does not match the installer', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agm-update-feed-'));
  try {
    const sourceDir = makeFixture(root, 'arm64');
    assert.throws(
      () =>
        prepareWindowsUpdateFeed({
          releaseTag,
          repository,
          sourceDir,
          outputDir: path.join(root, 'output'),
        }),
      /NSIS metadata does not match the release installer/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
