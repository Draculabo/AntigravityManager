import { execFileSync } from 'node:child_process';
import { z } from 'zod';

export const HashSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const TagSchema = z.string().regex(/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
const metadataFiles = new Set([
  'CHANGELOG.md',
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
]);

export function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  }).trim();
}

export function resolveHead(cwd, ref) {
  return HashSchema.parse(
    git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]),
  );
}

function filesInCommit(cwd, hash) {
  return git(cwd, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', hash])
    .split('\n')
    .filter(Boolean);
}

function isEditorialCommit(cwd, commit, version) {
  const files = filesInCommit(cwd, commit.hash);
  return (
    files.length > 0 &&
    (files.every((file) => file.startsWith('release-notes/')) ||
      (commit.subject === `chore(release): ${version}` &&
        files.every((file) => metadataFiles.has(file))))
  );
}

export function sourceCommits(cwd, baseTag, head, version) {
  if (baseTag) {
    TagSchema.parse(baseTag);
    git(cwd, ['merge-base', '--is-ancestor', baseTag, head]);
  }
  const range = baseTag ? `${baseTag}..${head}` : head;
  const log = git(cwd, ['log', '--no-merges', '--reverse', '--format=%H%x1f%s%x1f%an%x1e', range]);
  return log
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash, subject, authorName] = entry.split('\x1f');
      return { hash: HashSchema.parse(hash), subject, authorName };
    })
    .filter((commit) => !isEditorialCommit(cwd, commit, version));
}

export function verifyReviewedRange(cwd, review, head, version) {
  git(cwd, ['merge-base', '--is-ancestor', review.headSha, head]);
  const reviewed = sourceCommits(cwd, review.baseTag, review.headSha, version);
  const current = sourceCommits(cwd, review.baseTag, head, version);
  if (
    JSON.stringify(reviewed.map((commit) => commit.hash)) !==
    JSON.stringify(current.map((commit) => commit.hash))
  ) {
    throw new Error(
      'Release notes are stale: source commits changed after the reviewed draft. Regenerate and review the notes.',
    );
  }
  return current;
}
