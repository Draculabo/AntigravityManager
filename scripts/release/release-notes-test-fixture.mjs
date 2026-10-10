import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import config from '../../release.config.cjs';
import { createAutomaticStory } from './automatic-release-story.mjs';
import { git, resolveHead } from './release-source.mjs';

export const token = 'synthetic-release-token';
export const repository = 'fixture/project';
const logger = {
  log() {},
  success() {},
  error() {},
  warn() {},
  scope() {
    return this;
  },
};
export async function commit(cwd, file, message) {
  await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await writeFile(path.join(cwd, file), `${message}\n`);
  git(cwd, ['add', file]);
  git(cwd, ['commit', '-qm', message]);
  return resolveHead(cwd, 'HEAD');
}

export async function fixture(t) {
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
  const document = createAutomaticStory('0.24.1', data);
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
  return { cwd, data, document, context };
}

export function pull(number = 123, overrides = {}) {
  return {
    number,
    title: 'Restore desktop updates',
    merged_at: '2026-10-10T00:00:00Z',
    user: { login: 'fixture-author', type: 'User' },
    base: { ref: 'main', repo: { full_name: repository } },
    ...overrides,
  };
}

export function mockMetadata(t, head) {
  return t.mock.method(globalThis, 'fetch', async (url) =>
    String(url).includes('/pulls?')
      ? Response.json([pull()])
      : Response.json({ sha: head, author: { login: 'fixture-author', type: 'User' } }),
  );
}

export function collection(data, overrides = {}) {
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
