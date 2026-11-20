import { writeFileSync } from 'node:fs';
import { gh, Release, ReleaseId, releaseStatus, repository } from './release-candidate.mjs';

function releaseEndpoint(id) {
  return `repos/${repository()}/releases/${ReleaseId.parse(id)}`;
}

export function readReleaseById(id, request = gh) {
  const endpoint = releaseEndpoint(id);
  let release;
  try {
    release = Release.parse(JSON.parse(request(['api', endpoint])));
  } catch (cause) {
    throw new Error(`Cannot read GitHub Release ID ${id}`, { cause });
  }
  if (release.id !== id) {
    throw new Error(`GitHub returned Release ID ${release.id} for requested ID ${id}`);
  }
  return release;
}

export function verifyCandidateRelease(candidate, release) {
  const subject = `GitHub Release ID ${release.id}`;
  if (release.tag_name !== candidate.tag) {
    throw new Error(`${subject} has tag ${release.tag_name}, expected ${candidate.tag}`);
  }
  if (releaseStatus(release) === 'abandoned') {
    throw new Error(`${subject} for ${candidate.tag} has been abandoned`);
  }
  if (release.prerelease !== (candidate.channel === 'beta')) {
    throw new Error(`${subject} for ${candidate.tag} has the wrong prerelease status`);
  }
  if (release.body?.trimEnd() !== candidate.notes) {
    throw new Error(`${subject} for ${candidate.tag} differs from the recorded release notes`);
  }
}

export function ensureCandidateRelease(candidate, existing, notesPath, request = gh) {
  let id = existing?.id;
  if (id === undefined) {
    writeFileSync(notesPath, candidate.notes);
    const created = Release.parse(
      JSON.parse(
        request([
          'api',
          '--method',
          'POST',
          `repos/${repository()}/releases`,
          '-f',
          `tag_name=${candidate.tag}`,
          '-f',
          `name=${candidate.tag}`,
          '-F',
          `body=@${notesPath}`,
          '-F',
          'draft=true',
          '-F',
          `prerelease=${candidate.channel === 'beta'}`,
        ]),
      ),
    );
    id = created.id;
    console.log(`GitHub created Release ID ${id} for ${candidate.tag}`);
    verifyCandidateRelease(candidate, created);
    if (!created.draft) {
      throw new Error(`New GitHub Release ID ${id} for ${candidate.tag} is not a draft`);
    }
  }
  const release = readReleaseById(id, request);
  verifyCandidateRelease(candidate, release);
  if (!existing && !release.draft) {
    throw new Error(`New GitHub Release ID ${id} for ${candidate.tag} is not a draft`);
  }
  return release;
}

export function updateReleaseById(id, fields, request = gh) {
  request(['api', '--method', 'PATCH', releaseEndpoint(id), ...fields]);
}

export function uploadReleaseAssets(release, pending, allowReplace, remote, request = gh) {
  const uploadUrl = new URL(release.upload_url.split('{', 1)[0]);
  if (
    uploadUrl.origin !== 'https://uploads.github.com' ||
    uploadUrl.username ||
    uploadUrl.password ||
    uploadUrl.pathname.toLowerCase() !== `/${releaseEndpoint(release.id)}/assets`.toLowerCase() ||
    uploadUrl.search ||
    uploadUrl.hash
  ) {
    throw new Error(`GitHub returned an invalid asset upload URL for Release ID ${release.id}`);
  }
  const byName = new Map(remote.map((asset) => [asset.name, asset]));
  for (const asset of pending) {
    const existing = byName.get(asset.name);
    if (existing && allowReplace) {
      request([
        'api',
        '--method',
        'DELETE',
        `repos/${repository()}/releases/assets/${existing.id}`,
      ]);
    }
    uploadUrl.searchParams.set('name', asset.name);
    request([
      'api',
      '--method',
      'POST',
      uploadUrl.href,
      '-H',
      'Content-Type: application/octet-stream',
      '-H',
      `Content-Length: ${asset.size}`,
      '--input',
      asset.file,
    ]);
  }
}
