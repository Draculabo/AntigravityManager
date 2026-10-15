import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';

const location = spawnSync('git', ['rev-parse', '--git-path', 'hooks/pre-commit.old'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024,
  windowsHide: true,
});
if (location.error || location.status !== 0) {
  throw location.error ?? new Error('Cannot resolve the preserved pre-commit hook.');
}

const previous = path.resolve(location.stdout.trim());
if (
  existsSync(previous) &&
  (process.platform === 'win32' || (statSync(previous).mode & 0o111) !== 0)
) {
  const result = spawn.sync(previous, [], { stdio: 'inherit', windowsHide: true });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}
