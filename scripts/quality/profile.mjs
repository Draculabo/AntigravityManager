import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const PullEvent = z.object({
  pull_request: z.object({
    base: z.object({ sha: Sha }),
    head: z.object({ sha: Sha }),
  }),
});

/** Only a positive documentation allowlist can reduce application coverage. */
export function classifyPaths(paths) {
  return paths.length > 0 &&
    paths.every(
      (file) =>
        /^(?:README|CONTRIBUTING|CHANGELOG)\.md$/.test(file) ||
        /^docs\/(?!.*(?:^|\/)\.\.?\/)[^\0\r\n]+\.md$/.test(file),
    )
    ? 'docs'
    : 'full';
}

export function resolveProfile(env = process.env, cwd = process.cwd()) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'pull_request') {
    return { profile: 'full', reason: 'Full checks outside pull requests.' };
  }
  try {
    const event = PullEvent.parse(JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')));
    const git = (args) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        timeout: 15_000,
        windowsHide: true,
      });
    const base = git([
      'merge-base',
      event.pull_request.base.sha,
      event.pull_request.head.sha,
    ]).trim();
    const files = git([
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      base,
      event.pull_request.head.sha,
    ])
      .split('\0')
      .filter(Boolean);
    const profile = classifyPaths(files);
    return {
      profile,
      reason:
        profile === 'docs'
          ? 'Only allowlisted Markdown documentation changed.'
          : 'Code, configuration, tooling, mixed or unknown changes require full checks.',
    };
  } catch {
    return { profile: 'full', reason: 'Change detection unavailable; retaining full checks.' };
  }
}

export function profileChecks(checks, profile) {
  if (!['docs', 'full'].includes(profile)) {
    throw new Error('Unknown quality profile.');
  }
  return checks.map((check) => ({
    ...check,
    skip:
      profile === 'docs' &&
      check.script !== 'format' &&
      check.script !== 'check:quality' &&
      !check.groups?.includes('governance'),
  }));
}
