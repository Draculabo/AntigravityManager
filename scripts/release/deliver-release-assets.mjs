import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { buildUpdaterMetadata } from '../generate-updater-metadata.mjs';
import { prepareWindowsUpdateFeed } from '../prepare-windows-update-feed.mjs';
import {
  Candidate,
  gh,
  listReleases,
  ReleaseId,
  ReleaseTag,
  releaseStatus,
  repository,
} from './release-candidate.mjs';
import {
  readReleaseById,
  updateReleaseById,
  uploadReleaseAssets,
  verifyCandidateRelease,
} from './github-release-api.mjs';
import { validateReleaseArtifacts } from './validate-release-artifacts.mjs';

const uploadExtensions = new Set([
  '.exe',
  '.dmg',
  '.zip',
  '.AppImage',
  '.deb',
  '.rpm',
  '.msi',
  '.nupkg',
  '.yml',
  '.json',
  '.txt',
]);
const Asset = z.object({
  id: ReleaseId,
  name: z.string(),
  state: z.string(),
  size: z.number().int().nonnegative(),
  digest: z.string().nullish(),
});

function matchingAsset(expected, actual) {
  return (
    actual?.state === 'uploaded' &&
    expected.size === actual.size &&
    expected.digest === actual.digest
  );
}

export function planAssetUploads(expected, remote, allowReplace) {
  const byName = new Map(remote.map((asset) => [asset.name, asset]));
  const pending = [];
  for (const asset of expected) {
    const existing = byName.get(asset.name);
    if (matchingAsset(asset, existing)) {
      continue;
    }
    if (existing && !allowReplace) {
      throw new Error(`Published asset ${asset.name} differs. Use explicit manual replacement.`);
    }
    pending.push(asset);
  }
  return pending;
}

export function verifyAssetManifest(expected, remote, exact) {
  const missingOrChanged = planAssetUploads(expected, remote, true);
  const names = new Set(expected.map(({ name }) => name));
  const unexpected = exact ? remote.filter(({ name }) => !names.has(name)) : [];
  if (missingOrChanged.length || unexpected.length) {
    throw new Error(
      `Release assets differ from the manifest: ${[
        ...missingOrChanged.map(({ name }) => `missing or changed ${name}`),
        ...unexpected.map(({ name }) => `unexpected ${name}`),
      ].join(', ')}`,
    );
  }
}

export function reconcileRelease({ release, expected, mode }, client) {
  const status = releaseStatus(release);
  const formal = mode === 'publish';
  const alreadyPublished = formal && status === 'published';
  if (!alreadyPublished) {
    const allowReplace = status === 'draft' || mode === 'manual';
    const remote = client.assets();
    const pending = planAssetUploads(expected, remote, allowReplace);
    if (pending.length) {
      client.upload(pending, allowReplace, remote);
    }
  }
  const current = client.release();
  if (
    current.id !== release.id ||
    current.tag_name !== release.tag_name ||
    current.prerelease !== release.prerelease ||
    releaseStatus(current) !== status ||
    current.body !== release.body
  ) {
    throw new Error(`Release ${release.tag_name} changed while its assets were being verified`);
  }
  verifyAssetManifest(expected, client.assets(), formal);
  if (formal && !alreadyPublished) {
    client.publish();
    const published = client.release();
    if (
      published.id !== release.id ||
      published.tag_name !== release.tag_name ||
      published.prerelease !== release.prerelease ||
      published.body !== release.body ||
      releaseStatus(published) !== 'published'
    ) {
      throw new Error(`Unable to verify publication of ${release.tag_name}`);
    }
  }
}

async function fingerprint(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  const { size } = await stat(file);
  if (size === 0) {
    throw new Error(`Cannot publish empty asset ${path.basename(file)}`);
  }
  return { file, name: path.basename(file), size, digest: `sha256:${hash.digest('hex')}` };
}

function releaseAssets(id) {
  const pages = JSON.parse(
    gh([
      'api',
      '--paginate',
      '--slurp',
      `repos/${repository()}/releases/${id}/assets?per_page=100`,
    ]),
  );
  return z.array(z.array(Asset)).parse(pages).flat();
}

function findRelease(tag) {
  const releases = listReleases().filter(({ tag_name }) => tag_name === tag);
  if (releases.length !== 1) {
    throw new Error(`Expected exactly one existing GitHub Release for ${tag}`);
  }
  return releases[0];
}

async function buildAssetManifest({ sourceDir, release, candidate, temp }) {
  validateReleaseArtifacts({ sourceDir });
  const tag = release.tag_name;
  const owner = `https://github.com/${repository()}`;
  const updater = buildUpdaterMetadata(
    {
      tagName: tag,
      body: candidate?.notes ?? release.body,
      publishedAt: candidate?.preparedAt ?? release.published_at ?? release.created_at,
      url: `${owner}/releases/tag/${tag}`,
    },
    owner,
  );
  const updaterPath = path.join(temp, 'updater.json');
  await writeFile(updaterPath, `${JSON.stringify(updater, null, 2)}\n`);
  const output = path.join(temp, 'windows');
  prepareWindowsUpdateFeed({
    sourceDir,
    outputDir: output,
    releaseTag: tag,
    repository: repository(),
  });
  const entries = await readdir(sourceDir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && uploadExtensions.has(path.extname(entry.name)))
    .map((entry) => path.resolve(entry.parentPath, entry.name));
  files.push(updaterPath, path.join(output, 'win32', 'x64', 'RELEASES'));
  const names = new Set();
  for (const file of files) {
    const name = path.basename(file);
    if (names.has(name)) {
      throw new Error(`Multiple build outputs map to release asset ${name}`);
    }
    names.add(name);
  }
  return Promise.all(files.sort().map(fingerprint));
}

async function deliver(mode, sourceDir, input, releaseId) {
  const candidate =
    mode === 'publish' ? Candidate.parse(JSON.parse(await readFile(input, 'utf8'))) : null;
  const tag = candidate?.tag ?? ReleaseTag.parse(input);
  const release = candidate
    ? readReleaseById(
        z
          .string()
          .regex(/^[1-9]\d*$/)
          .transform(Number)
          .pipe(ReleaseId)
          .parse(releaseId),
      )
    : findRelease(tag);
  const status = releaseStatus(release);
  if (status === 'abandoned') {
    throw new Error(`Release ${tag} has been abandoned`);
  }
  if (candidate) {
    verifyCandidateRelease(candidate, release);
  }
  if (mode === 'event' && status !== 'published') {
    throw new Error(`Release ${tag} is no longer published`);
  }
  if (
    mode === 'manual' &&
    status === 'published' &&
    process.env.ALLOW_UPDATE_PUBLISHED_RELEASE !== 'true'
  ) {
    throw new Error('Set allow_update_published_release to upload to a published release');
  }

  const temp = await mkdtemp(path.join(tmpdir(), 'agm-release-assets-'));
  try {
    const expected = await buildAssetManifest({ sourceDir, release, candidate, temp });
    reconcileRelease(
      { release, expected, mode },
      {
        release: () => readReleaseById(release.id),
        assets: () => releaseAssets(release.id),
        upload: (pending, allowReplace, remote) =>
          uploadReleaseAssets(release, pending, allowReplace, remote),
        publish: () =>
          updateReleaseById(release.id, [
            '-F',
            'draft=false',
            '-f',
            `make_latest=${candidate?.channel === 'main'}`,
          ]),
      },
    );
    console.log(`Verified ${expected.length} GitHub Release assets for ${tag}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, sourceDir, input, releaseId] = process.argv.slice(2);
  if (!['publish', 'event', 'manual'].includes(mode)) {
    throw new Error('Expected publish, event, or manual');
  }
  await deliver(mode, sourceDir, input, releaseId);
}
