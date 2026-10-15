import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Cannot read staged code: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Lint index blobs using the worktree's ESLint policy, without stashing or staging fixes. */
export async function checkStagedLint(cwd = process.cwd()) {
  const files = git(
    ['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=ACM', '-z'],
    cwd,
  )
    .split('\0')
    .filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file));
  if (!files.length) {
    console.log('No staged JavaScript or TypeScript; lint skipped.');
    return 0;
  }
  const { ESLint } = await import('eslint');
  const eslint = new ESLint({ cwd, fix: false });
  const results = [];
  for (const file of files) {
    results.push(
      ...(await eslint.lintText(git(['show', `:0:${file}`], cwd), {
        filePath: path.resolve(cwd, file),
        warnIgnored: false,
      })),
    );
  }
  const formatter = await eslint.loadFormatter('stylish');
  const output = formatter.format(results);
  if (output) {
    console.log(output);
  }
  const failed = results.some((result) => result.errorCount > 0);
  if (failed) {
    console.error(
      'Staged lint failed. Fix the reported code and stage the intended changes again.',
    );
  } else {
    console.log(`Staged lint passed (${results.length} linted files).`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await checkStagedLint();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
