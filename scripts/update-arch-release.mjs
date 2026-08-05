import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PKGBUILD_PATH = 'packaging/arch/PKGBUILD';
const HASH_PATTERN = /^[a-f0-9]{64}$/i;

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const rawArg = argv[index];
    if (!rawArg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${rawArg}`);
    }

    const key = rawArg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }

    args[key] = value;
    index += 1;
  }

  return args;
}

function normalizeVersion(value) {
  const version = value?.trim().replace(/^v/, '');
  if (!version) {
    throw new Error('Version is required');
  }

  return version;
}

function readChecksum(checksumPath, artifactName) {
  const checksumText = fs.readFileSync(checksumPath, 'utf8');
  const line = checksumText
    .split(/\r?\n/)
    .find((entry) => entry.trimEnd().endsWith(`  ${artifactName}`));

  if (!line) {
    throw new Error(`Could not find ${artifactName} in ${checksumPath}`);
  }

  const [hash] = line.trim().split(/\s+/);
  if (!HASH_PATTERN.test(hash)) {
    throw new Error(`Invalid sha256 for ${artifactName}: ${hash}`);
  }

  return hash.toLowerCase();
}

function replaceRequiredLine(content, pattern, replacement, label) {
  if (!pattern.test(content)) {
    throw new Error(`Could not find ${label} in PKGBUILD`);
  }

  return content.replace(pattern, replacement);
}

function readRequiredValue(content, pattern, label) {
  const match = content.match(pattern);
  if (!match?.[1]) {
    throw new Error(`Could not find ${label} in PKGBUILD`);
  }

  return match[1];
}

export function updateArchReleaseMetadata({ version: rawVersion, checksumPath, pkgbuildPath }) {
  const version = normalizeVersion(rawVersion);
  if (!checksumPath) {
    throw new Error('Checksum path is required');
  }

  const resolvedPkgbuildPath = path.resolve(pkgbuildPath ?? DEFAULT_PKGBUILD_PATH);
  const artifactName = `Antigravity.Manager_${version}_amd64.deb`;
  const sha256 = readChecksum(checksumPath, artifactName);
  const originalPkgbuild = fs.readFileSync(resolvedPkgbuildPath, 'utf8');
  const currentVersion = readRequiredValue(
    originalPkgbuild,
    /^pkgver=['"]?([^'"\r\n]+)['"]?$/m,
    'pkgver',
  );
  const currentPkgrelText = readRequiredValue(originalPkgbuild, /^pkgrel=(\d+)$/m, 'pkgrel');
  const currentSha256 = readRequiredValue(
    originalPkgbuild,
    /^sha256sums=\(['"]([a-f0-9]{64}|SKIP)['"]\)$/im,
    'sha256sums',
  );
  const currentPkgrel = Number.parseInt(currentPkgrelText, 10);
  let pkgrel = 1;
  if (currentVersion === version) {
    pkgrel = currentSha256.toLowerCase() === sha256 ? currentPkgrel : currentPkgrel + 1;
  }

  let updatedPkgbuild = replaceRequiredLine(
    originalPkgbuild,
    /^pkgver=.*$/m,
    `pkgver=${version}`,
    'pkgver',
  );
  updatedPkgbuild = replaceRequiredLine(
    updatedPkgbuild,
    /^pkgrel=.*$/m,
    `pkgrel=${pkgrel}`,
    'pkgrel',
  );
  updatedPkgbuild = replaceRequiredLine(
    updatedPkgbuild,
    /^sha256sums=\(['"](?:[a-f0-9]{64}|SKIP)['"]\)$/im,
    `sha256sums=('${sha256}')`,
    'sha256sums',
  );

  const changed = updatedPkgbuild !== originalPkgbuild;
  if (changed) {
    fs.writeFileSync(resolvedPkgbuildPath, updatedPkgbuild);
  }

  return {
    changed,
    pkgrel,
    sha256,
    version,
  };
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const result = updateArchReleaseMetadata({
    version: args.version,
    checksumPath: args['amd64-checksums'],
    pkgbuildPath: args.pkgbuild,
  });
  console.log(
    `Updated ${path.relative(process.cwd(), path.resolve(args.pkgbuild ?? DEFAULT_PKGBUILD_PATH))} to ${result.version}-${result.pkgrel} (${result.sha256})`,
  );
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  runCli();
}
