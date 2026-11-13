import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseBuildTargets, resolveHead } from './release-source.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const SOURCE_SHA = /^[a-f0-9]{40}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createBuildSourceManifest(input) {
  if (!SOURCE_SHA.test(input.sourceSha)) {
    throw new Error(`Invalid source SHA: ${input.sourceSha}`);
  }
  if (!VERSION.test(input.version)) {
    throw new Error(`Invalid package version: ${input.version}`);
  }
  if (!input.platform || !input.arch) {
    throw new Error('Build platform and architecture are required.');
  }
  const artifacts = input.artifacts.map((artifact) => {
    if (!artifact.name || !Number.isSafeInteger(artifact.size) || artifact.size < 1) {
      throw new Error(`Invalid artifact metadata: ${JSON.stringify(artifact)}`);
    }
    if (!SHA256.test(artifact.sha256)) {
      throw new Error(`Invalid artifact checksum for ${artifact.name}`);
    }
    return {
      name: path.basename(artifact.name),
      size: artifact.size,
      sha256: artifact.sha256,
    };
  });
  return {
    schema: 1,
    sourceSha: input.sourceSha,
    version: input.version,
    platform: input.platform,
    arch: input.arch,
    artifacts,
  };
}

export function validateBuildSourceManifests(manifests) {
  if (manifests.length === 0) {
    throw new Error('No build source manifests were provided.');
  }
  const [first] = manifests;
  for (const manifest of manifests) {
    if (manifest.schema !== 1) {
      throw new Error(`Unsupported build source manifest schema: ${manifest.schema}`);
    }
    if (manifest.sourceSha !== first.sourceSha) {
      throw new Error(
        `Build source mismatch: ${manifest.platform}/${manifest.arch} uses ${manifest.sourceSha}, expected ${first.sourceSha}`,
      );
    }
    if (manifest.version !== first.version) {
      throw new Error(
        `Build version mismatch: ${manifest.platform}/${manifest.arch} uses ${manifest.version}, expected ${first.version}`,
      );
    }
    if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
      throw new Error(`No artifacts recorded for ${manifest.platform}/${manifest.arch}`);
    }
  }
  const keys = new Set();
  for (const manifest of manifests) {
    for (const artifact of manifest.artifacts) {
      const key = `${manifest.platform}/${manifest.arch}/${artifact.name}`;
      if (keys.has(key)) {
        throw new Error(`Duplicate release artifact: ${key}`);
      }
      keys.add(key);
    }
  }
  return {
    sourceSha: first.sourceSha,
    version: first.version,
    manifestCount: manifests.length,
    artifactCount: keys.size,
  };
}

export function validateReleaseAssetMatrix(manifests) {
  const source = validateBuildSourceManifests(manifests);
  const requirements = {
    win32: [
      { label: 'Squirrel setup', test: (name) => /-win32-(?:x64|arm64)-setup\.exe$/u.test(name) },
      { label: 'Squirrel package', test: (name) => name.endsWith('.nupkg') },
      { label: 'NSIS installer', test: (name) => /nsis\.exe$/u.test(name) },
      { label: 'NSIS metadata', test: (name) => /latest-nsis-(?:x64|arm64)\.yml$/u.test(name) },
    ],
    darwin: [
      { label: 'DMG', test: (name) => name.endsWith('.dmg') },
      { label: 'ZIP', test: (name) => name.endsWith('.zip') },
    ],
    linux: [
      { label: 'AppImage', test: (name) => name.endsWith('.AppImage') },
      { label: 'DEB', test: (name) => name.endsWith('.deb') },
      { label: 'RPM', test: (name) => name.endsWith('.rpm') },
    ],
  };
  for (const manifest of manifests) {
    const names = manifest.artifacts.map((artifact) => artifact.name);
    for (const requirement of requirements[manifest.platform] ?? []) {
      if (!names.some(requirement.test)) {
        throw new Error(`Missing ${requirement.label} for ${manifest.platform}/${manifest.arch}`);
      }
    }
  }
  return source;
}

export async function writeBuildSourceManifest(file, manifest) {
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export async function readBuildSourceManifest(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function validateReleaseDirectory(root, directory, releaseTag, expected = {}) {
  const files = (await listFiles(directory)).filter((file) =>
    /^build-source-.*\.json$/u.test(path.basename(file)),
  );
  const manifests = await Promise.all(files.map(readBuildSourceManifest));
  const targets = manifests.map(({ platform, arch }) => `${platform}-${arch}`).sort();
  if (JSON.stringify(targets) !== JSON.stringify(releaseBuildTargets)) {
    throw new Error(
      `Expected one build source manifest for each of the six targets; found: ${targets.join(', ')}`,
    );
  }
  const source = validateReleaseAssetMatrix(manifests);

  const checkoutSha = expected.sourceSha ?? resolveHead(root, 'HEAD');
  const version =
    expected.version ?? JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  if (source.sourceSha !== checkoutSha) {
    throw new Error(
      `Build source ${source.sourceSha} does not match checked-out commit ${checkoutSha}`,
    );
  }
  if (typeof version !== 'string' || !VERSION.test(version) || source.version !== version) {
    throw new Error(`Build version ${source.version} does not match package version ${version}`);
  }

  if (releaseTag !== undefined) {
    if (releaseTag !== `v${version}`) {
      throw new Error(`Release tag ${releaseTag} does not match package version ${version}`);
    }
    let tagSha;
    try {
      tagSha = resolveHead(root, `refs/tags/${releaseTag}`);
    } catch (cause) {
      throw new Error(`Release tag ${releaseTag} could not be resolved to a commit`, { cause });
    }
    if (tagSha !== checkoutSha) {
      throw new Error(`Release tag ${releaseTag} points to ${tagSha}, expected ${checkoutSha}`);
    }
  }
  return source;
}

export async function createBuildSourceManifestFromDirectory({
  root,
  directory,
  output,
  platform,
  arch,
  sourceSha,
  version,
}) {
  const resolvedSourceSha = sourceSha ?? resolveHead(root, 'HEAD');
  const resolvedVersion =
    version ?? JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  const files = (await listFiles(directory)).filter((file) =>
    /\.(?:exe|dmg|zip|AppImage|deb|rpm|msi|nupkg|yml|txt)$/u.test(file),
  );
  const artifacts = await Promise.all(
    files.map(async (file) => {
      const bytes = await readFile(file);
      return {
        name: path.relative(directory, file),
        size: (await stat(file)).size,
        sha256: sha256(bytes),
      };
    }),
  );
  const manifest = createBuildSourceManifest({
    sourceSha: resolvedSourceSha,
    version: resolvedVersion,
    platform,
    arch,
    artifacts,
  });
  await writeBuildSourceManifest(output, manifest);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${name}`);
    }
    args.set(name, value);
  }
  const root = path.resolve(args.get('--root') ?? process.cwd());
  if (args.has('--validate-directory')) {
    const source = await validateReleaseDirectory(
      root,
      path.resolve(root, args.get('--validate-directory')),
      args.get('--release-tag'),
      { sourceSha: args.get('--source-sha'), version: args.get('--version') },
    );
    console.log(JSON.stringify(source));
  } else {
    await createBuildSourceManifestFromDirectory({
      root,
      directory: path.resolve(root, args.get('--directory')),
      output: path.resolve(root, args.get('--output')),
      platform: args.get('--platform'),
      arch: args.get('--arch'),
      sourceSha: args.get('--source-sha'),
      version: args.get('--version'),
    });
  }
}
