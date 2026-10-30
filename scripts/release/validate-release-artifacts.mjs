import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { z } from 'zod';

const artifactPagesSchema = z.array(
  z.object({
    artifacts: z.array(z.object({ name: z.string(), expired: z.boolean() })),
  }),
);
const buildArtifacts = ['darwin', 'linux', 'win32']
  .flatMap((platform) => ['arm64', 'x64'].map((arch) => `make-${platform}-${arch}`))
  .sort();

function validateInventory(file) {
  // gh api --paginate --slurp returns one object per response page.
  const artifacts = artifactPagesSchema
    .parse(JSON.parse(readFileSync(file, 'utf8')))
    .flatMap((page) => page.artifacts)
    .filter((artifact) => artifact.name.startsWith('make-'));
  const names = artifacts.map((artifact) => artifact.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(buildArtifacts)) {
    throw new Error(`Expected all six build artifacts; found: ${names.join(', ') || 'none'}`);
  }
  if (artifacts.some((artifact) => artifact.expired)) {
    throw new Error('Build artifact inventory contains expired artifacts.');
  }
}

/** Check the merged upload layout before any release writes; feed contents have their own owner. */
export function validateReleaseArtifacts({ sourceDir, inventoryFile } = {}) {
  if (inventoryFile) {
    validateInventory(inventoryFile);
  }
  const files = readdirSync(sourceDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => statSync(file).size > 0)
    .map((file) => path.relative(sourceDir, file).split(path.sep).join('/'))
    .sort();
  const requirements = [];
  for (const arch of ['x64', 'arm64']) {
    requirements.push(
      [`Windows ${arch} setup`, (file) => file.endsWith(`-win32-${arch}-setup.exe`)],
      [
        `Windows ${arch} Squirrel package`,
        (file) => file.split('/').includes(arch) && file.endsWith('-full.nupkg'),
      ],
      [
        `Windows ${arch} RELEASES`,
        (file) => file.split('/').includes(arch) && path.posix.basename(file) === 'RELEASES',
      ],
      [
        `Windows ${arch} NSIS installer`,
        (file) =>
          file.split('/').includes('nsis') &&
          file.split('/').includes(arch) &&
          file.endsWith(`-windows-${arch}-nsis.exe`),
      ],
      [
        `Windows ${arch} NSIS metadata`,
        (file) =>
          file.split('/').includes('nsis') &&
          file.split('/').includes(arch) &&
          path.posix.basename(file) === `latest-nsis-${arch}.yml`,
      ],
      ...['dmg', 'zip'].map((extension) => [
        `macOS ${arch} ${extension}`,
        (file) => file.endsWith(`_${arch}.${extension}`),
      ]),
    );
  }
  requirements.push(['Windows x64 MSI', (file) => file.endsWith('_x64_en-US.msi')]);
  for (const [debArch, appImageArch, rpmArch] of [
    ['amd64', 'amd64', 'x86_64'],
    ['arm64', 'aarch64', 'aarch64'],
  ]) {
    requirements.push(
      [`Linux ${debArch} DEB`, (file) => file.endsWith(`_${debArch}.deb`)],
      [`Linux ${appImageArch} AppImage`, (file) => file.endsWith(`_${appImageArch}.AppImage`)],
      [`Linux ${rpmArch} RPM`, (file) => file.endsWith(`.${rpmArch}.rpm`)],
      [
        `Linux ${appImageArch} checksums`,
        (file) => path.posix.basename(file) === `sha256sums-linux-${appImageArch}.txt`,
      ],
    );
  }
  const missing = requirements
    .filter(([, matches]) => !files.some(matches))
    .map(([label]) => label);
  if (missing.length) {
    throw new Error(`Missing nonempty release assets: ${missing.join(', ')}`);
  }
  return files;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  new Command()
    .requiredOption('--source <directory>', 'Merged build artifact directory')
    .option('--inventory <file>', 'Paginated GitHub artifact inventory JSON from this run')
    .action(({ source, inventory }) => {
      const files = validateReleaseArtifacts({ sourceDir: source, inventoryFile: inventory });
      console.log(
        `Validated ${files.length} nonempty release asset files across six build targets.`,
      );
    })
    .parse();
}
