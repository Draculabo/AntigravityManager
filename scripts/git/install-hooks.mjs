import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const enabled = (value) => Boolean(value && value !== '0' && value !== 'false');
const root = process.cwd();

if (enabled(process.env.CI) || process.env.NODE_ENV === 'production') {
  process.stdout.write('Git hook installation skipped in CI or production.\n');
} else if (!existsSync(path.join(root, 'lefthook.yml'))) {
  process.stdout.write('Git hook installation skipped outside a configured checkout.\n');
} else {
  const git = (args) =>
    spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
  const repository = git(['rev-parse', '--show-toplevel']);
  if (
    repository.status !== 0 ||
    realpathSync.native(repository.stdout.trim()) !== realpathSync.native(root)
  ) {
    process.stdout.write('Git hook installation skipped outside the repository root.\n');
  } else {
    const configured = git(['config', '--get', 'core.hooksPath']);
    if (configured.status !== 1) {
      throw new Error(
        'A custom core.hooksPath or Git configuration error prevents installation. Keep existing hooks and resolve the configuration explicitly; no Git settings were changed.',
      );
    }
    const hookPath = git(['rev-parse', '--git-path', 'hooks/pre-push']);
    if (hookPath.status !== 0) {
      throw new Error('Cannot resolve the pre-push hook path.');
    }
    const existing = path.resolve(root, hookPath.stdout.trim());
    if (
      (existsSync(existing) && !readFileSync(existing, 'utf8').includes('call_lefthook')) ||
      existsSync(`${existing}.old`)
    ) {
      throw new Error(
        'An existing pre-push hook needs explicit integration before Lefthook installation.',
      );
    }
    const require = createRequire(import.meta.url);
    const result = spawnSync(process.execPath, [require.resolve('lefthook'), 'install'], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.error) {
      throw result.error;
    }
    process.exitCode = result.status ?? 1;
  }
}
