import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPORT_FORMAT_VERSION = 1;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function decodeGitOutput(output, streamName) {
  try {
    return utf8Decoder.decode(output ?? new Uint8Array());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to decode git ${streamName} as UTF-8: ${detail}`);
  }
}

function executeGit(rootDir, args) {
  const result = spawnSync('git', ['-C', rootDir, '-c', 'core.fsmonitor=false', ...args], {
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      LANG: 'C',
      LC_ALL: 'C',
    },
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });

  if (result.error) {
    throw new Error(`Unable to run git ${args.join(' ')}: ${result.error.message}`);
  }

  return {
    status: result.status,
    stderr: decodeGitOutput(result.stderr, 'stderr'),
    stdout: decodeGitOutput(result.stdout, 'stdout'),
  };
}

function runGit(rootDir, args) {
  const result = executeGit(rootDir, args);

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.status}`;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }

  return result.stdout;
}

function parseNullDelimitedPaths(output) {
  return [
    ...new Set(
      output
        .split('\0')
        .filter(Boolean)
        .map((filePath) => filePath.replaceAll('\\', '/')),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function collectPaths(rootDir, args) {
  return parseNullDelimitedPaths(runGit(rootDir, args));
}

function resolveCommit(rootDir, revision, label) {
  if (!revision) {
    throw new Error(`${label} revision is required`);
  }

  const args = [
    '-c',
    'core.warnAmbiguousRefs=true',
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${revision}^{commit}`,
  ];
  const result = executeGit(rootDir, args);

  if (result.stderr.includes(`refname '${revision}' is ambiguous`)) {
    throw new Error(`${label} revision "${revision}" is ambiguous`);
  }

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.status}`;
    throw new Error(`Unable to resolve ${label} revision "${revision}": ${detail}`);
  }

  return result.stdout.trim();
}

/**
 * Collect Git path changes without writing to the repository or its worktree.
 *
 * @param {string} rootDir repository root
 * @param {{ base?: string, head?: string }} [options] revisions to compare
 * @returns {{
 *   formatVersion: number,
 *   repositoryRoot: string,
 *   revisions: { base: { input: string, resolved: string }, head: { input: string, resolved: string }, mergeBase: string },
 *   paths: { committed: string[], staged: string[], unstaged: string[], untracked: string[] },
 *   changedPaths: string[],
 * }} versioned change-scope report
 */
export function collectChangeScope(rootDir, options = {}) {
  const repositoryRoot = path.resolve(rootDir);
  const baseInput = options.base;
  const headInput = options.head ?? 'HEAD';
  const base = resolveCommit(repositoryRoot, baseInput, 'base');
  const head = resolveCommit(repositoryRoot, headInput, 'head');
  const mergeBase = runGit(repositoryRoot, ['merge-base', base, head]).trim();
  const paths = {
    committed: collectPaths(repositoryRoot, ['diff', '--name-only', '-z', `${mergeBase}..${head}`]),
    staged: collectPaths(repositoryRoot, ['diff', '--cached', '--name-only', '-z']),
    unstaged: collectPaths(repositoryRoot, ['diff', '--name-only', '-z']),
    untracked: collectPaths(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
  };

  return {
    formatVersion: REPORT_FORMAT_VERSION,
    repositoryRoot,
    revisions: {
      base: { input: baseInput, resolved: base },
      head: { input: headInput, resolved: head },
      mergeBase,
    },
    paths,
    changedPaths: [...new Set(Object.values(paths).flat())].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}

function parseCliArguments(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--base' || argument === '--head') {
      const value = args[index + 1];

      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a revision`);
      }

      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const options = parseCliArguments(process.argv.slice(2));
    const report = collectChangeScope(path.resolve(import.meta.dirname, '..'), options);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Change scope collection failed: ${message}`);
    process.exitCode = 1;
  }
}
