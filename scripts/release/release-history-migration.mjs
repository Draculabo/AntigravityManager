import changelog from '@semantic-release/changelog';
import semver from 'semver';
import releaseConfig from '../../release.config.cjs';
import {
  assertCandidateMatches,
  commitTrailer,
  isChannelTag,
  latestPublishedTag,
  publishedBase,
  readCandidate,
  ReleaseTag,
  tagCommit,
} from './release-candidate.mjs';
import { git, resolveHead } from './release-source.mjs';
import { prepare as updatePackageVersion } from './update-package-version.mjs';

export function validateNewReleaseTag(cwd, channel, tag, releases) {
  ReleaseTag.parse(tag);
  if (tagCommit(cwd, tag) || releases.some(({ tag_name }) => tag_name === tag)) {
    throw new Error(
      `Release tag ${tag} already exists. Choose an unused migration version if the main history was rewritten.`,
    );
  }
  const latest = channel === 'main' ? latestPublishedTag(channel, releases) : null;
  if (latest && semver.lte(tag, latest)) {
    throw new Error(
      `Release tag ${tag} must be newer than the latest published ${channel} tag ${latest}`,
    );
  }
  return latest;
}

export function historyMigrationBaseline(cwd, channel, source, tag, releases) {
  if (channel !== 'main' || !isChannelTag(tag, 'main')) {
    throw new Error('A migration version must be a stable version on main');
  }
  const latest = validateNewReleaseTag(cwd, channel, tag, releases);
  if (
    !latest ||
    !tagCommit(cwd, latest) ||
    latest === publishedBase(cwd, channel, source, releases)
  ) {
    throw new Error(
      'A migration requires the latest published stable tag to be outside main history',
    );
  }
  return latest;
}

export async function recordHistoryMigration(cwd, candidate) {
  const { channel, source, tag, notes } = candidate;
  const branchRef = `refs/heads/${channel}`;
  const tagRef = `refs/tags/${tag}`;
  const metadataPaths = ['CHANGELOG.md', 'package.json'];
  if (git(cwd, ['status', '--porcelain', '--', ...metadataPaths])) {
    throw new Error('Start the release migration with clean release metadata files');
  }
  const changelogPlugin = releaseConfig.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/changelog',
  );
  const version = tag.slice(1);
  const context = { cwd, nextRelease: { version, notes }, logger: console };
  await changelog.prepare(changelogPlugin[1], context);
  await updatePackageVersion({}, context);
  git(cwd, [
    '-c',
    'user.name=semantic-release-bot',
    '-c',
    'user.email=semantic-release-bot@users.noreply.github.com',
    'commit',
    '--cleanup=verbatim',
    '--only',
    '-m',
    `chore(release): ${version}\n\n${notes}\n\n${commitTrailer(candidate)}`,
    '--',
    ...metadataPaths,
  ]);
  const commit = resolveHead(cwd, 'HEAD');
  assertCandidateMatches(candidate, readCandidate(cwd, commit));
  git(cwd, [
    'push',
    '--atomic',
    `--force-with-lease=${branchRef}:${source}`,
    `--force-with-lease=${tagRef}:`,
    'origin',
    `${commit}:${branchRef}`,
    `${commit}:${tagRef}`,
  ]);
}
