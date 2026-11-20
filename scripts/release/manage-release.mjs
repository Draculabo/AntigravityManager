import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import semanticRelease from 'semantic-release';
import releaseConfig from '../../release.config.cjs';
import { recordingPlugins } from './candidate-release-plugin.mjs';
import {
  abandonedBody,
  assertCandidateMatches,
  Candidate,
  Channel,
  gh,
  latestCandidateCommit,
  listReleases,
  publishedBase,
  readCandidate,
  releaseStatus,
  ReleaseTag,
  repository,
  tagCommit,
} from './release-candidate.mjs';
import { git, resolveHead } from './release-source.mjs';
import { generateNotes } from './github-release-notes.mjs';
import {
  historyMigrationBaseline,
  recordHistoryMigration,
  validateNewReleaseTag,
} from './release-history-migration.mjs';

const cwd = process.cwd();
const notesPlugin = './scripts/release/github-release-notes.mjs';
const channelRef = (channel) => `refs/remotes/origin/${channel}`;

function candidateCommit(channel, tag) {
  return tagCommit(cwd, tag) ?? latestCandidateCommit(cwd, channel);
}

function findRelease(tag) {
  const releases = listReleases().filter(({ tag_name }) => tag_name === tag);
  if (releases.length > 1) {
    throw new Error(`More than one GitHub Release has tag ${tag}`);
  }
  return releases[0];
}

function resumeCandidate(channel, tag) {
  const commit = candidateCommit(channel, tag);
  const candidate = commit && readCandidate(cwd, commit);
  if (!candidate || candidate.tag !== tag || candidate.channel !== channel) {
    throw new Error(`No managed ${channel} candidate found for ${tag}`);
  }
  const recent = latestCandidateCommit(cwd, channel);
  if (recent !== commit) {
    throw new Error(`A newer ${channel} release candidate supersedes ${tag}`);
  }
  if (releaseStatus(findRelease(tag)) === 'abandoned') {
    throw new Error(`${tag} has been abandoned`);
  }
  return candidate;
}

async function plan(channel, migrationVersion) {
  const source = resolveHead(cwd, 'HEAD');
  if (source !== resolveHead(cwd, channelRef(channel))) {
    throw new Error(`The checked out commit ${source} is no longer the tip of ${channel}`);
  }
  const releases = listReleases();
  const recent = latestCandidateCommit(cwd, channel);
  if (recent) {
    const candidate = readCandidate(cwd, recent);
    const status = releaseStatus(releases.find(({ tag_name }) => tag_name === candidate.tag));
    if (status === 'draft' || status === 'missing') {
      throw new Error(
        `Resume or abandon ${candidate.tag} on ${channel} before starting a new release`,
      );
    }
  }
  const baseTag = publishedBase(cwd, channel, source, releases);
  if (migrationVersion) {
    const tag = `v${migrationVersion}`;
    const historyMigrationFrom = historyMigrationBaseline(cwd, channel, source, tag, releases);
    const notes = await generateNotes(
      { baseTag },
      {
        cwd,
        nextRelease: { version: migrationVersion, gitHead: source },
        options: { repositoryUrl: `https://github.com/${repository()}.git` },
        branch: { name: channel },
        env: process.env,
      },
    );
    return Candidate.parse({
      channel,
      source,
      tag,
      previousTag: historyMigrationFrom,
      notesBase: baseTag,
      preparedAt: new Date().toISOString(),
      historyMigrationFrom,
      notes: notes.trimEnd(),
    });
  }
  const result = await semanticRelease({
    dryRun: true,
    plugins: [releaseConfig.plugins[0], [notesPlugin, { baseTag }]],
  });
  if (!result?.nextRelease) {
    return null;
  }
  if (result.nextRelease.gitHead !== source) {
    throw new Error('Semantic Release preview selected a different source revision');
  }
  validateNewReleaseTag(cwd, channel, result.nextRelease.gitTag, releases);
  return Candidate.parse({
    channel,
    source,
    tag: result.nextRelease.gitTag,
    previousTag: result.lastRelease.gitTag || null,
    notesBase: baseTag,
    preparedAt: new Date().toISOString(),
    notes: result.nextRelease.notes.trimEnd(),
  });
}

function writePlan(candidate, file) {
  if (!candidate) {
    appendFileSync(process.env.GITHUB_OUTPUT, 'has_candidate=false\n');
    return;
  }
  writeFileSync(file, `${JSON.stringify(candidate, null, 2)}\n`);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      'has_candidate=true',
      `source=${candidate.source}`,
      `version=${candidate.tag.slice(1)}`,
      `tag=${candidate.tag}`,
      '',
    ].join('\n'),
  );
}

function ensureTagAndChannel(candidate, commit) {
  const { channel, tag } = candidate;
  const ref = `refs/notes/semantic-release-${tag}`;
  const note = { channels: [channel === 'main' ? null : channel] };
  const existingTag = tagCommit(cwd, tag);
  if (existingTag && existingTag !== commit) {
    throw new Error(`${tag} points to ${existingTag}; expected release commit ${commit}`);
  }
  if (!existingTag) {
    git(cwd, ['tag', tag, commit]);
  }
  const remoteNote = git(cwd, ['ls-remote', '--refs', 'origin', ref]);
  if (remoteNote) {
    git(cwd, ['fetch', 'origin', `${ref}:${ref}`]);
    const actual = JSON.parse(git(cwd, ['notes', `--ref=${ref}`, 'show', commit]));
    if (JSON.stringify(actual.channels) !== JSON.stringify(note.channels)) {
      throw new Error(`The Semantic Release channel record for ${tag} does not match ${channel}`);
    }
  } else {
    git(cwd, [
      '-c',
      'user.name=semantic-release-bot',
      '-c',
      'user.email=semantic-release-bot@users.noreply.github.com',
      'notes',
      `--ref=${ref}`,
      'add',
      '-m',
      JSON.stringify(note),
      commit,
    ]);
  }
  if (!existingTag || !remoteNote) {
    git(cwd, ['push', '--atomic', 'origin', `refs/tags/${tag}:refs/tags/${tag}`, `${ref}:${ref}`]);
  }
}

function verifyDraft(candidate, release) {
  if (
    releaseStatus(release) === 'abandoned' ||
    release?.prerelease !== (candidate.channel === 'beta') ||
    release.body?.trimEnd() !== candidate.notes
  ) {
    throw new Error(
      `The GitHub Release for ${candidate.tag} does not match its recorded candidate`,
    );
  }
}

function ensureDraft(candidate, notesPath) {
  const existing = findRelease(candidate.tag);
  if (existing) {
    verifyDraft(candidate, existing);
    return;
  }
  writeFileSync(notesPath, candidate.notes);
  gh([
    'release',
    'create',
    candidate.tag,
    '--draft',
    '--verify-tag',
    '--title',
    candidate.tag,
    '--notes-file',
    notesPath,
    ...(candidate.channel === 'beta' ? ['--prerelease', '--latest=false'] : []),
  ]);
  verifyDraft(candidate, findRelease(candidate.tag));
}

async function record(candidate, notesPath) {
  const { channel, source, tag } = candidate;
  const head = resolveHead(cwd, channelRef(channel));
  const recent = latestCandidateCommit(cwd, channel);
  if (head === source && !tagCommit(cwd, tag)) {
    if (resolveHead(cwd, 'HEAD') !== source) {
      throw new Error(`The release job must check out the original source ${source}`);
    }
    const releases = listReleases();
    if (publishedBase(cwd, channel, source, releases) !== candidate.notesBase) {
      throw new Error('The published notes baseline changed; start a new release');
    }
    if (candidate.historyMigrationFrom) {
      const latest = historyMigrationBaseline(cwd, channel, source, tag, releases);
      if (latest !== candidate.historyMigrationFrom) {
        throw new Error(`The migration baseline changed to ${latest}; start a new release`);
      }
      await recordHistoryMigration(cwd, candidate);
    } else {
      validateNewReleaseTag(cwd, channel, tag, releases);
      const result = await semanticRelease({
        dryRun: false,
        plugins: recordingPlugins(releaseConfig.plugins, candidate),
      });
      if (!result?.nextRelease) {
        throw new Error(`Semantic Release did not record ${tag}`);
      }
    }
    git(cwd, ['fetch', '--tags', 'origin', channel]);
  } else if (!recent || readCandidate(cwd, recent)?.tag !== tag) {
    if (tagCommit(cwd, tag)) {
      throw new Error(`Release tag ${tag} already exists outside the recorded candidate`);
    }
    throw new Error(`The source branch advanced to ${head}; start a new release from ${channel}`);
  }

  const commit = candidateCommit(channel, tag);
  const recorded = commit && readCandidate(cwd, commit);
  if (!recorded || latestCandidateCommit(cwd, channel) !== commit) {
    throw new Error(`The release commit for ${tag} is missing or no longer current`);
  }
  assertCandidateMatches(candidate, recorded);
  ensureTagAndChannel(candidate, commit);
  ensureDraft(candidate, notesPath);
}

function abandon(channel, tag, notesPath) {
  const commit = candidateCommit(channel, tag);
  const candidate = commit && readCandidate(cwd, commit);
  if (
    !candidate ||
    candidate.tag !== tag ||
    candidate.channel !== channel ||
    latestCandidateCommit(cwd, channel) !== commit
  ) {
    throw new Error(`There is no current managed candidate ${tag} on ${channel}`);
  }
  const status = releaseStatus(findRelease(tag));
  if (status === 'abandoned') {
    return;
  }
  if (status === 'published') {
    throw new Error(`Cannot abandon published release ${tag}`);
  }
  ensureTagAndChannel(candidate, commit);
  ensureDraft(candidate, notesPath);
  writeFileSync(notesPath, abandonedBody(candidate.notes));
  gh(['release', 'edit', tag, '--notes-file', notesPath]);
  if (releaseStatus(findRelease(tag)) !== 'abandoned') {
    throw new Error(`Could not verify that ${tag} was abandoned`);
  }
}

const [operation, file, notesPath] = process.argv.slice(2);
const channel = Channel.parse(process.env.GITHUB_REF_NAME);
const migrationVersion = process.env.RELEASE_MIGRATION_VERSION?.trim();
if (
  migrationVersion &&
  (operation === 'abandon' || (operation === 'plan' && process.env.RELEASE_OPERATION !== 'release'))
) {
  throw new Error('A migration version can only be used when starting a release');
}
switch (operation) {
  case 'plan':
    if (!['release', 'resume'].includes(process.env.RELEASE_OPERATION)) {
      throw new Error('Expected the release or resume operation');
    }
    writePlan(
      process.env.RELEASE_OPERATION === 'resume'
        ? resumeCandidate(channel, ReleaseTag.parse(process.env.RELEASE_TAG))
        : await plan(channel, migrationVersion),
      file,
    );
    break;
  case 'record':
    await record(Candidate.parse(JSON.parse(readFileSync(file, 'utf8'))), notesPath);
    break;
  case 'abandon':
    abandon(channel, ReleaseTag.parse(process.env.RELEASE_TAG), file);
    break;
  default:
    throw new Error(`Unknown release operation ${operation}`);
}
