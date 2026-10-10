import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateNotes } from './github-release-notes.mjs';
import { collectReleaseData, repositoryName } from './github-release-data.mjs';
import { DocumentSchema, renderReleaseDocument } from './release-document.mjs';
import { createDraft } from './prepare-release-notes.mjs';
import { git, resolveHead, sourceCommits, verifyReviewedRange } from './release-source.mjs';

const require = createRequire(import.meta.url);
const config = require('../../release.config.cjs');
const root = fileURLToPath(new URL('../../', import.meta.url));
const token = 'synthetic-release-token';
const repository = 'fixture/project';
const logger = {
  log() {},
  success() {},
  error() {},
  warn() {},
  scope() {
    return this;
  },
};
const { default: loadPlugins } = await import(
  pathToFileURL(
    path.join(path.dirname(require.resolve('semantic-release')), 'lib/plugins/index.js'),
  ).href
);

async function commit(cwd, file, message) {
  await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await writeFile(path.join(cwd, file), `${message}\n`);
  git(cwd, ['add', file]);
  git(cwd, ['commit', '-qm', message]);
  return resolveHead(cwd, 'HEAD');
}

async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agm-release-notes-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.name', 'Fixture Author']);
  git(cwd, ['config', 'user.email', 'fixture@example.invalid']);
  await commit(cwd, 'base.txt', 'chore: initial state');
  git(cwd, ['tag', 'v0.24.0']);
  const head = await commit(cwd, 'src/update.txt', 'fix(update): restore updates');
  const data = {
    repository,
    baseTag: 'v0.24.0',
    headSha: head,
    commits: [
      {
        hash: head,
        subject: 'fix(update): restore updates',
        authorName: 'Fixture Author',
        login: 'fixture-author',
        bot: false,
        resolved: true,
        pullNumbers: [123],
      },
    ],
    pullRequests: [
      { number: 123, title: 'Restore desktop updates', login: 'fixture-author', bot: false },
    ],
  };
  const entry = {
    title: 'Reliable updates',
    text: 'Desktop users can install the latest version again.',
    references: [`commit:${head}`],
  };
  const document = {
    schemaVersion: 1,
    version: '0.24.1',
    reviewed: true,
    source: { baseTag: data.baseTag, headSha: head },
    overview: 'This release restores desktop updates.',
    highlights: [entry],
    sections: [{ area: 'desktop', items: [entry] }],
    upgradeNotes: [],
  };
  const file = path.join(cwd, 'release-notes/v0.24.1.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(document));
  const context = {
    cwd,
    env: { GITHUB_TOKEN: token },
    stdout: process.stdout,
    stderr: process.stderr,
    logger,
    options: { ...config, repositoryUrl: `https://github.com/${repository}.git`, dryRun: true },
    branch: { name: 'main' },
    commits: [{ hash: head, message: data.commits[0].subject }],
    lastRelease: { gitTag: data.baseTag },
    nextRelease: { version: document.version, gitTag: 'v0.24.1', gitHead: head },
  };
  return { cwd, file, data, document, context };
}

function pull(number = 123, overrides = {}) {
  return {
    number,
    title: 'Restore desktop updates',
    merged_at: '2026-10-10T00:00:00Z',
    user: { login: 'fixture-author', type: 'User' },
    base: { ref: 'main', repo: { full_name: repository } },
    ...overrides,
  };
}

function mockMetadata(t, head) {
  return t.mock.method(globalThis, 'fetch', async (url) =>
    String(url).includes('/pulls?')
      ? Response.json([pull()])
      : Response.json({ sha: head, author: { login: 'fixture-author', type: 'User' } }),
  );
}

function collection(data, overrides = {}) {
  return {
    repository,
    baseTag: data.baseTag,
    headSha: data.headSha,
    commits: data.commits.map(({ hash, subject, authorName }) => ({ hash, subject, authorName })),
    branch: 'main',
    env: { GITHUB_TOKEN: token },
    ...overrides,
  };
}

test('actual semantic-release loader delivers the complete story to changelog and GitHub', async (t) => {
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
  git(f.cwd, ['add', 'release-notes/v0.24.1.json']);
  git(f.cwd, ['commit', '-qm', 'docs: review release notes']);
  assert.equal(
    await plugins.generateNotes({
      ...f.context,
      nextRelease: { ...f.context.nextRelease, gitHead: resolveHead(f.cwd, 'HEAD'), notes },
    }),
    notes,
  );
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

test('additional source changes invalidate review before any metadata request', async (t) => {
  const f = await fixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Must not request metadata');
  });
  const head = await commit(f.cwd, 'src/new.txt', 'fix: another source change');
  await assert.rejects(
    generateNotes({}, { ...f.context, nextRelease: { ...f.context.nextRelease, gitHead: head } }),
    /stale/,
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test('a release-shaped commit changing source cannot bypass review', async (t) => {
  const f = await fixture(t);
  const head = await commit(f.cwd, 'src/new.txt', 'chore(release): 0.24.1');
  assert.throws(() => verifyReviewedRange(f.cwd, f.document.source, head, '0.24.1'), /stale/);
});

for (const scenario of ['missing', 'unreviewed', 'wrong version', 'wrong base']) {
  test(`blocks ${scenario} release documents`, async (t) => {
    const f = await fixture(t);
    if (scenario === 'missing') {
      await rm(f.file);
    } else {
      const document = structuredClone(f.document);
      if (scenario === 'unreviewed') {
        document.reviewed = false;
      }
      if (scenario === 'wrong version') {
        document.version = '0.24.2';
      }
      if (scenario === 'wrong base') {
        document.source.baseTag = 'v0.23.0';
      }
      await writeFile(f.file, JSON.stringify(document));
    }
    await assert.rejects(generateNotes({}, f.context), /review|invalid|does not match/);
  });
}

test('rejects invented references throughout the narrative and missing domain coverage', async (t) => {
  const { document, data } = await fixture(t);
  for (const field of ['overview', 'upgrade', 'highlight', 'foreign PR', 'reference', 'coverage']) {
    const changed = structuredClone(document);
    if (field === 'overview') {
      changed.overview = 'Includes #999.';
    }
    if (field === 'upgrade') {
      changed.upgradeNotes = ['See #999.'];
    }
    if (field === 'highlight') {
      changed.highlights[0].text = 'See https://github.com/fixture/project/pull/999.';
    }
    if (field === 'foreign PR') {
      changed.overview = 'See https://github.com/foreign/project/pull/123.';
    }
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
  assert.equal(DocumentSchema.safeParse(createDraft('0.24.1', data)).success, false);
});

test('first and beta releases use their own comparison boundaries', async (t) => {
  const { document, data } = await fixture(t);
  document.version = '0.25.0-beta.2';
  document.source.baseTag = data.baseTag = 'v0.25.0-beta.1';
  assert.match(
    renderReleaseDocument(document, data),
    /compare\/v0.25.0-beta.1\.\.\.v0.25.0-beta.2/,
  );
  data.baseTag = document.source.baseTag = null;
  assert.match(
    renderReleaseDocument(document, data),
    /\*\*First release:\*\*[\s\S]*commits\/v0.25.0-beta.2/,
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

test("local drafts recognize only GitHub's exact missing-commit 422 response", async (t) => {
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

test('preview CLI renders offline, refuses overwrites and detects mismatched facts', async (t) => {
  const f = await fixture(t);
  const source = path.join(f.cwd, 'facts.json');
  const output = path.join(f.cwd, 'preview.md');
  await writeFile(source, JSON.stringify(f.data));
  const args = [
    path.join(root, 'scripts/release/prepare-release-notes.mjs'),
    'preview',
    '--document',
    f.file,
    '--data',
    source,
    '--output',
    output,
    '--date',
    '2026-10-10',
  ];
  const execute = () =>
    execFileSync(process.execPath, args, {
      cwd: f.cwd,
      stdio: 'pipe',
      maxBuffer: 4000,
      windowsHide: true,
    });
  execute();
  assert.equal(
    await readFile(output, 'utf8'),
    `${renderReleaseDocument(f.document, f.data, '2026-10-10')}\n`,
  );
  assert.throws(execute, /EEXIST/);
  f.data.headSha = 'a'.repeat(40);
  await writeFile(source, JSON.stringify(f.data));
  assert.throws(execute, /do not match/);
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
