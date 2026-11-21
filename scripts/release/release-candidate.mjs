import { execFileSync } from 'node:child_process';
import semver from 'semver';
import { z } from 'zod';
import { git, HashSchema, resolveHead, TagSchema } from './release-source.mjs';

export const Channel = z.enum(['main', 'beta']);
export const ReleaseTag = TagSchema.refine((tag) => semver.valid(tag.slice(1)) !== null);
const CandidateMetadata = z.strictObject({
  channel: Channel,
  source: HashSchema,
  tag: ReleaseTag,
  previousTag: ReleaseTag.nullable(),
  notesBase: ReleaseTag.nullable(),
  preparedAt: z.iso.datetime(),
  historyMigrationFrom: ReleaseTag.optional(),
});
export const Candidate = CandidateMetadata.extend({ notes: z.string().min(1) })
  .refine(
    ({ channel, tag }) => isChannelTag(tag, channel),
    'The tag must belong to the release channel',
  )
  .refine(
    ({ channel, previousTag, historyMigrationFrom }) =>
      historyMigrationFrom === undefined ||
      (channel === 'main' &&
        historyMigrationFrom === previousTag &&
        isChannelTag(historyMigrationFrom, 'main')),
    'A history migration must record its previous stable tag on main',
  );

export const ReleaseId = z.int().positive();
export const Release = z.object({
  id: ReleaseId,
  tag_name: z.string(),
  body: z.string().nullable(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  created_at: z.iso.datetime(),
  published_at: z.iso.datetime().nullable(),
  upload_url: z.string(),
});
const candidateTrailer = 'AGM-Release-Candidate:';
const abandonedSuffix = '\n\n<!-- agm-release-abandoned -->';
const metadataFiles = new Set(['CHANGELOG.md', 'package.json', 'pnpm-lock.yaml']);

export function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  }).trim();
}

export function repository() {
  return z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .parse(process.env.GITHUB_REPOSITORY);
}

export function listReleases() {
  return z
    .array(z.array(Release))
    .parse(
      JSON.parse(
        gh(['api', '--paginate', '--slurp', `repos/${repository()}/releases?per_page=100`]),
      ),
    )
    .flat();
}

export function isChannelTag(tag, channel) {
  const parsed = semver.parse(tag);
  return (
    parsed !== null &&
    (channel === 'main' ? parsed.prerelease.length === 0 : parsed.prerelease[0] === 'beta')
  );
}

export function publishedBase(cwd, channel, source, releases) {
  const reachable = new Set(git(cwd, ['tag', '--merged', source, '--list', 'v*']).split('\n'));
  const reachableReleases = releases.filter(({ tag_name }) => reachable.has(tag_name));
  return (
    latestPublishedTag(channel, reachableReleases) ??
    (channel === 'beta' ? latestPublishedTag('main', reachableReleases) : null)
  );
}

export function latestPublishedTag(channel, releases) {
  return (
    releases
      .filter(
        (release) =>
          releaseStatus(release) === 'published' &&
          release.prerelease === (channel === 'beta') &&
          isChannelTag(release.tag_name, channel),
      )
      .map(({ tag_name }) => tag_name)
      .sort(semver.rcompare)[0] ?? null
  );
}

export function releaseStatus(release) {
  if (!release) {
    return 'missing';
  }
  if (release.body?.trimEnd().endsWith(abandonedSuffix)) {
    return 'abandoned';
  }
  return release.draft ? 'draft' : 'published';
}

export function abandonedBody(notes) {
  return notes + abandonedSuffix;
}

export function commitTrailer(candidate) {
  const { notes, ...metadata } = Candidate.parse(candidate);
  return `${candidateTrailer} ${metadata.channel} ${Buffer.from(JSON.stringify(metadata)).toString('base64url')}`;
}

export function readCandidate(cwd, commit) {
  const message = git(cwd, ['show', '-s', '--format=%B', commit]);
  const separator = `\n\n${candidateTrailer} `;
  const offset = message.lastIndexOf(separator);
  if (offset === -1) {
    return null;
  }
  const [channel, encoded] = message.slice(offset + separator.length).split(' ');
  const metadata = CandidateMetadata.parse(JSON.parse(Buffer.from(encoded, 'base64url')));
  const prefix = `chore(release): ${metadata.tag.slice(1)}\n\n`;
  if (metadata.channel !== channel || !message.startsWith(prefix)) {
    throw new Error(`Invalid release candidate metadata in ${commit}`);
  }
  const candidate = Candidate.parse({ ...metadata, notes: message.slice(prefix.length, offset) });
  const parents = git(cwd, ['show', '-s', '--format=%P', commit]);
  const files = git(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', commit]).split('\n');
  const manifest = JSON.parse(git(cwd, ['show', `${commit}:package.json`]));
  if (
    parents !== candidate.source ||
    !files.includes('CHANGELOG.md') ||
    files.some((file) => !metadataFiles.has(file)) ||
    manifest.version !== candidate.tag.slice(1)
  ) {
    throw new Error(
      `Release commit ${commit} does not match ${candidate.tag} at ${candidate.source}`,
    );
  }
  return candidate;
}

export function tagCommit(cwd, tag) {
  return git(cwd, ['tag', '--list', ReleaseTag.parse(tag)])
    ? resolveHead(cwd, `refs/tags/${tag}`)
    : null;
}

export function latestCandidateCommit(cwd, channel) {
  return (
    git(cwd, [
      'log',
      '-1',
      '--format=%H',
      '--first-parent',
      `--grep=^${candidateTrailer} ${Channel.parse(channel)} `,
      `refs/remotes/origin/${channel}`,
    ]) || null
  );
}

export function assertCandidateMatches(expected, actual) {
  if (JSON.stringify(Candidate.parse(expected)) !== JSON.stringify(Candidate.parse(actual))) {
    throw new Error(
      `Recorded release metadata does not match ${expected.tag} at ${expected.source}`,
    );
  }
}
