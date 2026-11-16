import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { reconcileRelease } from './deliver-release-assets.mjs';
import {
  abandonedBody,
  commitTrailer,
  publishedBase,
  readCandidate,
} from './release-candidate.mjs';
import { commit, fixture } from './release-notes-test-fixture.mjs';
import { git, resolveHead, sourceCommits } from './release-source.mjs';

const installer = { name: 'setup.exe', size: 42, digest: 'sha256:expected' };
const updater = { name: 'updater.json', size: 20, digest: 'sha256:metadata' };
const draft = { id: 10, tag_name: 'v0.24.1', draft: true, body: 'Release notes' };
const uploaded = (asset) => ({ ...asset, state: 'uploaded' });

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
