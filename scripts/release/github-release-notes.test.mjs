import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateNotes } from './github-release-notes.mjs';
import { collectReleaseData, repositoryName } from './github-release-data.mjs';
import { renderReleaseDocument } from './release-document.mjs';
import { createReleaseNotesCommand } from './prepare-release-notes.mjs';
import { createAutomaticStory } from './automatic-release-story.mjs';
import { git, resolveHead, sourceCommits } from './release-source.mjs';

import {
  fixture,
  commit,
  mockMetadata,
  collection,
  pull,
  token,
  repository,
} from './release-notes-test-fixture.mjs';

const require = createRequire(import.meta.url);
const config = require('../../release.config.cjs');
const root = fileURLToPath(new URL('../../', import.meta.url));
const { default: loadPlugins } = await import(
  pathToFileURL(
    path.join(path.dirname(require.resolve('semantic-release')), 'lib/plugins/index.js'),
  ).href
);

test('actual semantic-release loader publishes complete automatic notes without a version JSON', async (t) => {
  const f = await fixture(t);
  mockMetadata(t, f.data.headSha);
  // Resolve plugins in the repository; execute with isolated fixture Git history.
  const plugins = await loadPlugins({ ...f.context, cwd: root }, {});
  const notes = await plugins.generateNotes(f.context);
  assert.equal(notes, renderReleaseDocument(f.document, f.data));
  assert.match(notes, /1 commit · 1 merged PR · 1 verified contributor/);
  assert.match(notes, /\[#123\]\(https:\/\/github.com\/fixture\/project\/pull\/123\)/);
  assert.match(
    notes,
    /Highlights[\s\S]*Desktop & User Experience[\s\S]*Contributors[\s\S]*@fixture-author/,
  );
  assert.doesNotMatch(notes, /New Contributors|Local preview/);
  const changelog = await import('@semantic-release/changelog');
  const changelogOptions = config.plugins.find(
    (plugin) => plugin[0] === '@semantic-release/changelog',
  )[1];
  await changelog.prepare(changelogOptions, {
    ...f.context,
    nextRelease: { ...f.context.nextRelease, notes },
  });
  assert.equal(
    await readFile(path.join(f.cwd, 'CHANGELOG.md'), 'utf8'),
    `${changelogOptions.changelogTitle}\n\n${notes}\n`,
  );
  const { default: publishGithub } = await import(
    pathToFileURL(
      path.join(path.dirname(require.resolve('@semantic-release/github')), 'lib/publish.js'),
    ).href
  );
  let published;
  class FixtureOctokit {
    async request(route, release) {
      assert.equal(route, 'POST /repos/{owner}/{repo}/releases');
      published = release;
      return {
        data: { html_url: 'https://github.com/fixture/project/releases/tag/v0.24.1', id: 123 },
      };
    }
  }
  const githubOptions = config.plugins.find(
    (plugin) => plugin[0] === '@semantic-release/github',
  )[1];
  await publishGithub(
    githubOptions,
    { ...f.context, nextRelease: { ...f.context.nextRelease, notes } },
    { Octokit: FixtureOctokit },
  );
  assert.equal(published.body, notes);
  assert.equal(published.name, 'v0.24.1');
  assert.equal(published.tag_name, 'v0.24.1');
  await commit(f.cwd, 'package.json', 'chore(release): 0.24.1');
  git(f.cwd, ['add', 'CHANGELOG.md']);
  git(f.cwd, ['commit', '-qm', 'chore(release): 0.24.1']);
  assert.equal(
    await plugins.generateNotes({
      ...f.context,
      nextRelease: { ...f.context.nextRelease, gitHead: resolveHead(f.cwd, 'HEAD'), notes },
    }),
    notes,
  );
});

test('additional source changes are included automatically on regeneration', async (t) => {
  const f = await fixture(t);
  const head = await commit(f.cwd, 'src/new.txt', 'fix: another source change');
  t.mock.method(globalThis, 'fetch', async (url) =>
    String(url).includes('/pulls?')
      ? Response.json([])
      : Response.json({ sha: String(url).split('/').at(-1), author: null }),
  );
  const notes = await generateNotes(
    {},
    { ...f.context, nextRelease: { ...f.context.nextRelease, gitHead: head } },
  );
  assert.match(notes, /2 commits/);
  assert.match(notes, /another source change/);
  assert.match(notes, new RegExp(`commit/${head}`));
});

test('a release-shaped commit changing source is retained in the source range', async (t) => {
  const f = await fixture(t);
  const head = await commit(f.cwd, 'src/new.txt', 'chore(release): 0.24.1');
  assert.deepEqual(
    sourceCommits(f.cwd, 'v0.24.0', head, '0.24.1').map((entry) => entry.hash),
    [f.data.headSha, head],
  );
});

for (const nextRelease of [
  { version: '../invalid', gitHead: 'a'.repeat(40) },
  { version: '0.24.1', gitHead: 'invalid' },
]) {
  test(`rejects invalid semantic-release target ${JSON.stringify(nextRelease)}`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      generateNotes({}, { ...f.context, nextRelease }),
      /semantic version and an exact release commit/,
    );
  });
}

test('rejects out-of-range references and missing domain coverage', async (t) => {
  const { document, data } = await fixture(t);
  for (const field of ['reference', 'coverage']) {
    const changed = structuredClone(document);
    if (field === 'reference') {
      changed.sections[0].items[0].references = ['pr:999'];
    }
    if (field === 'coverage') {
      changed.sections[0].items = [];
    }
    assert.throws(() => renderReleaseDocument(changed, data), /unverified|outside|omits/);
  }
});

test('direct authors are included, bots separated and attribution never guessed', async (t) => {
  const { document, data } = await fixture(t);
  const direct = {
    ...data.commits[0],
    hash: 'a'.repeat(40),
    login: 'direct-author',
    pullNumbers: [],
  };
  const bot = { ...direct, hash: 'b'.repeat(40), login: 'automation', bot: true };
  data.commits.push(direct, bot);
  document.sections[0].items.push({
    title: 'Maintenance',
    text: 'Restore updater metadata.',
    references: [`commit:${direct.hash}`, `commit:${bot.hash}`],
  });
  const notes = renderReleaseDocument(document, data, '2026-10-10');
  assert.match(notes, /3 commits · 1 merged PR · 2 verified contributors/);
  assert.match(notes, /@fixture-author · @direct-author/);
  assert.match(notes, /Maintenance: @automation/);
  assert.match(notes, /commit\/aaaaaaaa/);
});

test('first and beta releases generate automatically from their own Git boundaries', async (t) => {
  const f = await fixture(t);
  git(f.cwd, ['tag', 'v0.25.0-beta.1', 'v0.24.0']);
  t.mock.method(globalThis, 'fetch', async (url) =>
    String(url).includes('/pulls?')
      ? Response.json([])
      : Response.json({ sha: String(url).split('/').at(-1), author: null }),
  );
  const context = {
    ...f.context,
    branch: { name: 'beta' },
    nextRelease: { version: '0.25.0-beta.2', gitHead: f.data.headSha },
  };
  assert.match(
    await generateNotes({}, { ...context, lastRelease: { gitTag: 'v0.25.0-beta.1' } }),
    /1 commit[\s\S]*compare\/v0.25.0-beta.1\.\.\.v0.25.0-beta.2/,
  );
  assert.match(
    await generateNotes({}, { ...context, lastRelease: {} }),
    /\*\*First release:\*\* 2 commits[\s\S]*commits\/v0.25.0-beta.2/,
  );
});

test('metadata paginates, deduplicates and excludes unmerged, foreign and other-branch PRs', async (t) => {
  const { data } = await fixture(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), options });
    if (!String(url).includes('/pulls?')) {
      return Response.json({
        sha: data.headSha,
        author: { login: 'fixture-author', type: 'User' },
      });
    }
    if (String(url).endsWith('page=1')) {
      return Response.json(Array.from({ length: 100 }, () => pull()));
    }
    return Response.json([
      pull(),
      pull(124, { merged_at: null }),
      pull(125, { base: { ref: 'beta', repo: { full_name: repository } } }),
      pull(126, { base: { ref: 'main', repo: { full_name: 'foreign/project' } } }),
    ]);
  });
  assert.deepEqual(
    await collectReleaseData(
      collection(data, { env: { GH_TOKEN: token, GITHUB_TOKEN: 'unused' } }),
    ),
    data,
  );
  assert.equal(requests.length, 3);
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(requests[0].options.redirect, 'error');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
});

test('unknown GitHub authors retain Git names without guessing a handle', async (t) => {
  const { data, document } = await fixture(t);
  t.mock.method(globalThis, 'fetch', async (url) =>
    String(url).includes('/pulls?')
      ? Response.json([])
      : Response.json({ sha: data.headSha, author: null }),
  );
  const facts = await collectReleaseData(collection(data, { env: {} }));
  assert.deepEqual(facts.commits, [{ ...data.commits[0], login: null, pullNumbers: [] }]);
  assert.deepEqual(facts.pullRequests, []);
  const notes = renderReleaseDocument(document, facts);
  assert.match(notes, /0 verified contributors/);
  assert.match(notes, /Git authors without verified GitHub attribution: Fixture Author/);
});

test('unpublished commits are allowed only in explicitly incomplete local previews', async (t) => {
  const { data, document } = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  await assert.rejects(collectReleaseData(collection(data)), /HTTP 404/);
  const local = await collectReleaseData(collection(data, { allowLocal: true, env: {} }));
  assert.deepEqual(local.commits, [
    { ...data.commits[0], login: null, resolved: false, pullNumbers: [] },
  ]);
  assert.match(renderReleaseDocument(document, local), /Local preview[\s\S]*incomplete/);
});

test("local previews recognize only GitHub's exact missing-commit 422 response", async (t) => {
  const { data } = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ message: `No commit found for SHA: ${data.headSha}` }, { status: 422 }),
  );
  const local = await collectReleaseData(collection(data, { allowLocal: true }));
  assert.equal(local.commits[0].resolved, false);
  await assert.rejects(collectReleaseData(collection(data)), /HTTP 422/);
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ message: 'Validation failed' }, { status: 422 }),
  );
  await assert.rejects(collectReleaseData(collection(data, { allowLocal: true })), /HTTP 422/);
});

for (const status of [401, 403, 429, 500]) {
  test(`HTTP ${status} fails without exposing provider credentials`, async (t) => {
    const { data } = await fixture(t);
    t.mock.method(globalThis, 'fetch', async () => new Response(token, { status }));
    await assert.rejects(
      collectReleaseData(collection(data)),
      (error) =>
        error.message === `GitHub release metadata request failed (HTTP ${status}).` &&
        !error.cause,
    );
  });
}

for (const scenario of ['timeout', 'invalid JSON', 'wrong SHA', 'invalid PRs']) {
  test(`rejects ${scenario} metadata safely`, async (t) => {
    const { data } = await fixture(t);
    t.mock.method(globalThis, 'fetch', async (url) => {
      if (scenario === 'timeout') {
        throw new Error(token);
      }
      if (scenario === 'invalid JSON') {
        return new Response('{');
      }
      if (scenario === 'wrong SHA') {
        return Response.json({ sha: 'a'.repeat(40), author: null });
      }
      return String(url).includes('/pulls?')
        ? Response.json([{ number: 123 }])
        : Response.json({ sha: data.headSha, author: null });
    });
    await assert.rejects(
      collectReleaseData(collection(data)),
      (error) =>
        /failed|invalid/.test(error.message) && !error.message.includes(token) && !error.cause,
    );
  });
}

test('preview command generates notes from the range, refuses overwrites and validates dates', async (t) => {
  const f = await fixture(t);
  const output = path.join(f.cwd, 'preview.md');
  mockMetadata(t, f.data.headSha);
  t.mock.method(process, 'cwd', () => f.cwd);
  git(f.cwd, ['remote', 'add', 'origin', 'https://github.com/fixture/project.git']);
  const args = [
    'preview',
    '--base',
    'v0.24.0',
    '--version',
    '0.24.1',
    '--anonymous',
    '--output',
    output,
    '--date',
    '2026-10-10',
  ];
  const execute = () => createReleaseNotesCommand().parseAsync(args, { from: 'user' });
  await execute();
  assert.equal(
    await readFile(output, 'utf8'),
    `${renderReleaseDocument(f.document, f.data, '2026-10-10')}\n`,
  );
  await assert.rejects(execute(), /EEXIST/);
  args[args.length - 1] = 'not-a-date';
  await assert.rejects(execute(), /YYYY-MM-DD/);
});

test('range reader uses Git history rather than PR-looking commit text', async (t) => {
  const f = await fixture(t);
  const head = await commit(f.cwd, 'src/new.txt', 'fix: repair issue (#999)');
  assert.deepEqual(
    sourceCommits(f.cwd, 'v0.24.0', head, '0.24.1').map((entry) => entry.hash),
    [f.data.headSha, head],
  );
});

test('GitHub repository transports normalize without reflecting credentials', () => {
  for (const url of [
    'git@github.com:fixture/project.git',
    'ssh://git@github.com/fixture/project.git',
    'https://github.com/fixture/project.git',
    'https://synthetic-secret@github.com/fixture/project.git',
  ]) {
    assert.equal(repositoryName(url), repository);
  }
  assert.throws(() => repositoryName('https://synthetic-secret@example.invalid/fixture/project'), {
    message: 'Release notes require a GitHub repository URL.',
  });
});

test('automatic story groups PR commits, ranks highlights and covers maintenance changes', async (t) => {
  const { data } = await fixture(t);
  data.commits.push(
    { ...data.commits[0], hash: 'a'.repeat(40), subject: 'fix(update): retry download' },
    {
      ...data.commits[0],
      hash: 'b'.repeat(40),
      subject: 'feat(proxy)!: require explicit credentials',
      pullNumbers: [],
    },
    {
      ...data.commits[0],
      hash: 'c'.repeat(40),
      subject: 'chore(build): refresh dependencies (#999)',
      pullNumbers: [],
    },
  );
  const fix = {
    title: 'Fix',
    text: 'Restore desktop updates',
    references: [`commit:${data.headSha}`, `commit:${'a'.repeat(40)}`],
  };
  const breaking = {
    title: 'Breaking change',
    text: 'require explicit credentials',
    references: [`commit:${'b'.repeat(40)}`],
  };
  const maintenance = {
    title: 'Maintenance',
    text: 'refresh dependencies',
    references: [`commit:${'c'.repeat(40)}`],
  };
  assert.deepEqual(createAutomaticStory('0.25.0', data), {
    schemaVersion: 1,
    version: '0.25.0',
    source: { baseTag: data.baseTag, headSha: data.headSha },
    overview:
      'This release includes updates in Desktop & User Experience, Security & Reliability, Tooling & Maintenance.',
    highlights: [breaking, fix, maintenance],
    sections: [
      { area: 'desktop', items: [fix] },
      { area: 'security', items: [breaking] },
      { area: 'tooling', items: [maintenance] },
    ],
    upgradeNotes: [],
  });
  const notes = renderReleaseDocument(createAutomaticStory('0.25.0', data), data);
  assert.equal(
    notes
      .split('## 🖥️ Desktop & User Experience')[1]
      .split('---')[0]
      .match(/Restore desktop updates/g).length,
    1,
  );
  assert.doesNotMatch(notes, /#999/);
  assert.throws(
    () => createAutomaticStory('0.25.0', { ...data, commits: [] }),
    /at least one source change/,
  );
});

test('source titles render as text rather than injecting Markdown links or headings', async (t) => {
  const { data } = await fixture(t);
  data.pullRequests[0].title = '[Unsafe](https://example.invalid)\n#999';
  const notes = renderReleaseDocument(createAutomaticStory('0.24.1', data), data);
  assert.ok(notes.includes('\\[Unsafe\\](https://example.invalid) \\#999'));
  assert.ok(notes.includes('[#123](https://github.com/fixture/project/pull/123)'));
});
