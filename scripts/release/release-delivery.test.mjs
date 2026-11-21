import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import semanticRelease from 'semantic-release';
import { reconcileRelease } from './deliver-release-assets.mjs';
import {
  ensureCandidateRelease,
  readReleaseById,
  updateReleaseById,
  uploadReleaseAssets,
  verifyCandidateRelease,
} from './github-release-api.mjs';
import {
  abandonedBody,
  commitTrailer,
  publishedBase,
  readCandidate,
} from './release-candidate.mjs';
import { commit, fixture } from './release-notes-test-fixture.mjs';
import {
  historyMigrationBaseline,
  recordHistoryMigration,
  validateNewReleaseTag,
} from './release-history-migration.mjs';
import { git, resolveHead, sourceCommits } from './release-source.mjs';

const installer = { name: 'setup.exe', size: 42, digest: 'sha256:expected' };
const updater = { name: 'updater.json', size: 20, digest: 'sha256:metadata' };
const draft = { id: 10, tag_name: 'v0.24.1', draft: true, body: 'Release notes' };
const uploaded = (asset) => ({ ...asset, state: 'uploaded' });

async function draftFixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'agm-release-draft-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const previousRepository = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_REPOSITORY = 'fixture/project';
  t.after(() => {
    if (previousRepository === undefined) {
      delete process.env.GITHUB_REPOSITORY;
    } else {
      process.env.GITHUB_REPOSITORY = previousRepository;
    }
  });
  const release = {
    ...draft,
    prerelease: false,
    created_at: '2026-11-20T08:00:00Z',
    published_at: null,
    upload_url: 'https://uploads.github.com/repos/fixture/project/releases/10/assets{?name,label}',
  };
  return {
    release,
    notesPath: path.join(cwd, 'notes.md'),
    candidate: { tag: release.tag_name, channel: 'main', notes: release.body },
  };
}

test('a draft absent from the release list can be read, uploaded and published by its returned ID', async (t) => {
  const { release, notesPath, candidate } = await draftFixture(t);
  const calls = [];
  let current = release;
  let assets = [];
  const file = path.join(path.dirname(notesPath), installer.name);
  const expected = [{ ...installer, file }];
  const request = (args) => {
    calls.push(args);
    if (
      args[1] === '--method' &&
      args[2] === 'POST' &&
      args[3] === 'repos/fixture/project/releases'
    ) {
      return JSON.stringify(current);
    }
    if (args[1] === 'repos/fixture/project/releases/10') {
      return JSON.stringify(current);
    }
    if (
      args[2] === 'POST' &&
      args[3] ===
        'https://uploads.github.com/repos/fixture/project/releases/10/assets?name=setup.exe'
    ) {
      assets = [uploaded(installer)];
      return '{}';
    }
    if (args[2] === 'PATCH' && args[3] === 'repos/fixture/project/releases/10') {
      current = { ...release, draft: false, published_at: '2026-11-20T08:30:00Z' };
      return JSON.stringify(current);
    }
    assert.fail(`Unexpected GitHub request: ${args.join(' ')}`);
  };

  const recorded = ensureCandidateRelease(candidate, undefined, notesPath, request);
  assert.equal(await readFile(notesPath, 'utf8'), candidate.notes);
  reconcileRelease(
    { release: recorded, expected, mode: 'publish' },
    {
      release: () => readReleaseById(recorded.id, request),
      assets: () => assets,
      upload: (pending, allowReplace, remote) =>
        uploadReleaseAssets(recorded, pending, allowReplace, remote, request),
      publish: () =>
        updateReleaseById(recorded.id, ['-F', 'draft=false', '-f', 'make_latest=true'], request),
    },
  );
  assert.equal(current.draft, false);
  assert.deepEqual(calls, [
    [
      'api',
      '--method',
      'POST',
      'repos/fixture/project/releases',
      '-f',
      `tag_name=${candidate.tag}`,
      '-f',
      `name=${candidate.tag}`,
      '-F',
      `body=@${notesPath}`,
      '-F',
      'draft=true',
      '-F',
      'prerelease=false',
    ],
    ['api', 'repos/fixture/project/releases/10'],
    [
      'api',
      '--method',
      'POST',
      'https://uploads.github.com/repos/fixture/project/releases/10/assets?name=setup.exe',
      '-H',
      'Content-Type: application/octet-stream',
      '-H',
      'Content-Length: 42',
      '--input',
      file,
    ],
    ['api', 'repos/fixture/project/releases/10'],
    [
      'api',
      '--method',
      'PATCH',
      'repos/fixture/project/releases/10',
      '-F',
      'draft=false',
      '-f',
      'make_latest=true',
    ],
    ['api', 'repos/fixture/project/releases/10'],
  ]);
});

test('draft recovery reports unreadable IDs separately from mismatched notes and does not recreate an existing release', async (t) => {
  const { release, notesPath, candidate } = await draftFixture(t);
  const calls = [];
  const request = (args) => {
    calls.push(args);
    return JSON.stringify({ ...release, body: 'Changed release notes' });
  };
  assert.throws(
    () => ensureCandidateRelease(candidate, release, notesPath, request),
    /ID 10.*differs from the recorded release notes/,
  );
  assert.deepEqual(calls, [['api', 'repos/fixture/project/releases/10']]);
  const failure = new Error('HTTP 404');
  assert.throws(
    () =>
      readReleaseById(release.id, () => {
        throw failure;
      }),
    { message: 'Cannot read GitHub Release ID 10', cause: failure },
  );
  assert.throws(
    () => verifyCandidateRelease(candidate, { ...release, prerelease: true }),
    /wrong prerelease status/,
  );
  assert.throws(
    () => verifyCandidateRelease(candidate, { ...release, tag_name: 'v0.24.2' }),
    /expected v0\.24\.1/,
  );
});

test('release uploads delete only the replaced asset and reject an upload endpoint for another release', async (t) => {
  const { release } = await draftFixture(t);
  const pending = [{ ...installer, file: 'setup.exe' }];
  const remote = [{ ...uploaded(installer), id: 99, digest: 'sha256:old' }];
  const calls = [];
  const request = (args) => calls.push(args);
  uploadReleaseAssets(release, pending, true, remote, request);
  assert.deepEqual(calls[0], [
    'api',
    '--method',
    'DELETE',
    'repos/fixture/project/releases/assets/99',
  ]);
  assert.match(calls[1][3], /\/releases\/10\/assets/);
  assert.throws(
    () =>
      uploadReleaseAssets(
        { ...release, upload_url: release.upload_url.replace('/10/', '/11/') },
        pending,
        true,
        remote,
        request,
      ),
    /invalid asset upload URL for Release ID 10/,
  );
  assert.equal(calls.length, 2);
});

async function rewrittenMain(t) {
  const { cwd } = await fixture(t);
  const shared = resolveHead(cwd, 'v0.24.0');
  git(cwd, ['tag', '-d', 'v0.24.0']);
  git(cwd, ['tag', 'v0.21.2', shared]);
  git(cwd, ['switch', '-qc', 'old-main', shared]);
  git(cwd, ['tag', 'v0.22.0', await commit(cwd, 'old.txt', 'feat: original release')]);
  const previous = await commit(cwd, 'old.txt', 'fix: last stable release');
  git(cwd, ['tag', 'v0.32.1', previous]);
  git(cwd, ['switch', '-qC', 'main', shared]);
  await writeFile(
    path.join(cwd, 'package.json'),
    '{"name":"fixture","private":true,"version":"0.32.1"}\n',
  );
  await writeFile(path.join(cwd, 'CHANGELOG.md'), '# Changelog\n');
  git(cwd, ['add', 'package.json', 'CHANGELOG.md']);
  git(cwd, ['commit', '-qm', 'feat: rewritten main']);
  const source = resolveHead(cwd, 'HEAD');
  const origin = path.join(cwd, 'origin.git');
  git(cwd, ['init', '-q', '--bare', origin]);
  git(cwd, ['remote', 'add', 'origin', origin]);
  git(cwd, ['push', '-q', 'origin', 'main', '--tags']);
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const releases = ['v0.21.2', 'v0.22.0', 'v0.32.1'].map((tag_name) => ({
    tag_name,
    draft: false,
    prerelease: false,
  }));
  const candidate = {
    channel: 'main',
    source,
    tag: 'v0.33.0',
    previousTag: 'v0.32.1',
    historyMigrationFrom: 'v0.32.1',
    notesBase: 'v0.21.2',
    preparedAt: '2026-11-20T08:00:00.000Z',
    notes: '## Changes\n\n- Stable release from the rewritten main history.',
  };
  return { cwd, origin, previous, releases, candidate };
}

test('the Release resume entry accepts either form spelling and emits the frozen candidate', async (t) => {
  const { cwd, candidate } = await rewrittenMain(t);
  await recordHistoryMigration(cwd, candidate);
  git(cwd, ['fetch', '--tags', 'origin', 'main']);
  const script = fileURLToPath(new URL('./manage-release.mjs', import.meta.url));
  const fakeGitHub = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import assert from 'node:assert/strict';
    const run = childProcess.execFileSync;
    childProcess.execFileSync = (file, args, options) => {
      if (file !== 'gh') return run(file, args, options);
      assert.deepEqual(args, ['api', '--paginate', '--slurp', 'repos/fixture/project/releases?per_page=100']);
      return '[[]]';
    };
    syncBuiltinESMExports();
  `;
  const preload = `data:text/javascript;base64,${Buffer.from(fakeGitHub).toString('base64')}`;
  const invoke = (input, filename) =>
    spawnSync(process.execPath, ['--import', preload, script, 'plan', filename], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REF_NAME: 'main',
        GITHUB_REPOSITORY: 'fixture/project',
        GITHUB_OUTPUT: `${filename}.out`,
        RELEASE_OPERATION: 'resume',
        RELEASE_TAG: input,
        RELEASE_MIGRATION_VERSION: '',
      },
    });

  for (const [index, input] of ['0.33.0', 'v0.33.0'].entries()) {
    const file = path.join(cwd, `candidate-${index}.json`);
    const result = invoke(input, file);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), candidate);
    assert.equal(
      await readFile(`${file}.out`, 'utf8'),
      `has_candidate=true\nsource=${candidate.source}\nversion=0.33.0\ntag=v0.33.0\n`,
    );
  }
  const invalidFile = path.join(cwd, 'invalid-candidate.json');
  const invalid = invoke('0.33', invalidFile);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Enter an existing version in release_tag/);
  await assert.rejects(readFile(invalidFile), { code: 'ENOENT' });
});

function previewVersion(cwd, repositoryUrl) {
  return semanticRelease(
    {
      repositoryUrl,
      branches: ['main'],
      dryRun: true,
      ci: false,
      plugins: ['@semantic-release/commit-analyzer'],
    },
    { cwd, env: { ...process.env, CI: '', GITHUB_ACTIONS: '' } },
  );
}

test('a rewritten main rejects the occupied automatic version before packaging and can anchor a higher version', async (t) => {
  const { cwd, origin, previous, releases, candidate } = await rewrittenMain(t);
  const { source, tag } = candidate;
  const automatic = await previewVersion(cwd, origin);
  assert.equal(automatic.lastRelease.gitTag, 'v0.21.2');
  assert.equal(automatic.nextRelease.gitTag, 'v0.22.0');
  assert.throws(
    () => validateNewReleaseTag(cwd, 'main', automatic.nextRelease.gitTag, releases),
    /v0\.22\.0 already exists/,
  );
  assert.throws(
    () => historyMigrationBaseline(cwd, 'main', source, 'v0.23.1', releases),
    /newer.*v0\.32\.1/,
  );
  assert.throws(
    () => historyMigrationBaseline(cwd, 'beta', source, tag, releases),
    /stable version on main/,
  );
  assert.equal(historyMigrationBaseline(cwd, 'main', source, tag, releases), 'v0.32.1');
  assert.equal(resolveHead(origin, 'refs/heads/main'), source);
  assert.equal(git(origin, ['tag', '--list', tag]), '');

  await recordHistoryMigration(cwd, candidate);
  git(cwd, ['fetch', '--tags', 'origin', 'main']);

  const recorded = resolveHead(origin, 'refs/heads/main');
  assert.equal(resolveHead(origin, `refs/tags/${tag}`), recorded);
  assert.equal(resolveHead(origin, 'refs/tags/v0.32.1'), previous);
  assert.deepEqual(readCandidate(origin, recorded), candidate);
  const published = [...releases, { tag_name: tag, draft: false, prerelease: false }];
  assert.equal(publishedBase(cwd, 'main', recorded, published), tag);
  const nextSource = await commit(cwd, 'src/next.txt', 'fix: next update');
  git(cwd, ['push', '-q', 'origin', 'main']);
  assert.throws(
    () => historyMigrationBaseline(cwd, 'main', nextSource, 'v0.34.0', published),
    /outside main history/,
  );
  const next = await previewVersion(cwd, origin);
  assert.equal(next.lastRelease.gitTag, tag);
  assert.equal(next.nextRelease.gitTag, 'v0.33.1');
  assert.equal(validateNewReleaseTag(cwd, 'main', next.nextRelease.gitTag, published), tag);
});

test('a tag created during packaging rejects the migration without updating the remote branch', async (t) => {
  const { cwd, origin, previous, candidate } = await rewrittenMain(t);
  git(origin, ['tag', candidate.tag, previous]);
  await assert.rejects(recordHistoryMigration(cwd, candidate), /stale info|rejected/);
  assert.equal(resolveHead(origin, 'refs/heads/main'), candidate.source);
  assert.equal(resolveHead(origin, `refs/tags/${candidate.tag}`), previous);
});

test('main advancing during packaging rejects the migration without creating the remote tag', async (t) => {
  const { cwd, origin, candidate } = await rewrittenMain(t);
  git(cwd, ['switch', '-qc', 'another-change']);
  const next = await commit(cwd, 'src/next.txt', 'fix: advance main');
  git(cwd, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  git(cwd, ['switch', '-q', 'main']);
  await assert.rejects(recordHistoryMigration(cwd, candidate), /stale info|rejected/);
  assert.equal(resolveHead(origin, 'refs/heads/main'), next);
  assert.equal(git(origin, ['tag', '--list', candidate.tag]), '');
});

test('a failed GitHub upload leaves the release in draft and a retry publishes only after readback', () => {
  const events = [];
  const assets = [];
  let release = draft;
  let shouldFail = true;
  const client = {
    release: () => release,
    assets: () => {
      events.push(`read ${assets.length}`);
      return assets;
    },
    upload: (pending) => {
      events.push(`upload ${pending.map(({ name }) => name).join(',')}`);
      assets.push(uploaded(pending[0]));
      if (shouldFail) {
        throw new Error('Interrupted upload');
      }
    },
    publish: () => {
      events.push('publish');
      release = { ...draft, draft: false };
    },
  };
  const context = { release, expected: [installer, updater], mode: 'publish' };
  assert.throws(() => reconcileRelease(context, client), /Interrupted upload/);
  assert.equal(release.draft, true);
  shouldFail = false;
  reconcileRelease(context, client);
  assert.equal(release.draft, false);
  reconcileRelease({ ...context, release }, client);
  assert.deepEqual(events, [
    'read 0',
    'upload setup.exe,updater.json',
    'read 1',
    'upload updater.json',
    'read 2',
    'publish',
    'read 2',
  ]);
});

test('an incomplete or corrupted remote attachment never publishes a draft', () => {
  assert.throws(
    () =>
      reconcileRelease(
        { release: draft, expected: [installer], mode: 'publish' },
        {
          release: () => draft,
          assets: () => [uploaded({ ...installer, digest: 'sha256:corrupted' })],
          upload: () => {},
          publish: () => assert.fail('published a draft with the wrong attachment'),
        },
      ),
    /missing or changed setup.exe/,
  );
});

test('a published event only fills missing files, while explicit manual repair can replace a conflict', () => {
  const release = { ...draft, draft: false };
  const context = { release, expected: [installer, updater] };
  let assets = [uploaded({ ...installer, digest: 'sha256:older' })];
  const calls = [];
  const client = {
    release: () => release,
    assets: () => assets,
    upload: (pending, replace) => {
      calls.push({ names: pending.map(({ name }) => name), replace });
      assets = [
        ...assets.filter((asset) => !pending.some(({ name }) => name === asset.name)),
        ...pending.map(uploaded),
      ];
    },
    publish: () => assert.fail('attachment repair published a release'),
  };
  assert.throws(
    () => reconcileRelease({ ...context, mode: 'event' }, client),
    /Published asset setup.exe differs/,
  );
  assert.deepEqual(calls, []);
  reconcileRelease({ ...context, mode: 'manual' }, client);
  assets = assets.filter(({ name }) => name !== updater.name);
  reconcileRelease({ ...context, mode: 'event' }, client);
  assert.deepEqual(calls, [
    { names: ['setup.exe', 'updater.json'], replace: true },
    { names: ['updater.json'], replace: false },
  ]);
});

test('abandoning a tagged candidate preserves its source changes in the next public notes', async (t) => {
  const { cwd } = await fixture(t);
  const source = resolveHead(cwd, 'HEAD');
  const candidate = {
    channel: 'main',
    source,
    tag: 'v0.24.1',
    previousTag: 'v0.24.0',
    notesBase: 'v0.24.0',
    preparedAt: '2026-11-16T01:00:00.000Z',
    notes: 'Approved notes\n\nMore details.',
  };
  await writeFile(path.join(cwd, 'package.json'), '{"version":"0.24.1"}\n');
  await writeFile(path.join(cwd, 'CHANGELOG.md'), `${candidate.notes}\n`);
  git(cwd, ['add', 'package.json', 'CHANGELOG.md']);
  git(cwd, [
    'commit',
    '-qm',
    `chore(release): 0.24.1\n\n${candidate.notes}\n\n${commitTrailer(candidate)}`,
  ]);
  const releaseCommit = resolveHead(cwd, 'HEAD');
  git(cwd, ['tag', candidate.tag, releaseCommit]);
  const laterSource = await commit(cwd, 'src/later.txt', 'fix: finish recovery');
  const releases = [
    {
      tag_name: candidate.tag,
      draft: true,
      prerelease: false,
      body: abandonedBody(candidate.notes),
    },
    { tag_name: 'v0.24.0', draft: false, prerelease: false, body: 'Previous release' },
  ];
  assert.deepEqual(readCandidate(cwd, releaseCommit), candidate);
  assert.equal(resolveHead(cwd, candidate.tag), releaseCommit);
  const base = publishedBase(cwd, 'main', laterSource, releases);
  assert.equal(base, 'v0.24.0');
  assert.deepEqual(
    sourceCommits(cwd, base, laterSource, '0.24.2').map(({ hash }) => hash),
    [source, laterSource],
  );
});
