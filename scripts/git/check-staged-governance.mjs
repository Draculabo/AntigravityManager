import { spawnSync } from 'node:child_process';
import spawn from 'cross-spawn';

const staged = spawnSync('git', ['diff', '--cached', '--name-only', '-z', '--no-renames'], {
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
  windowsHide: true,
});

if (staged.error || staged.status !== 0) {
  process.stderr.write('Cannot inspect staged governance paths. Fix the Git error and retry.\n');
  process.stderr.write(staged.error?.message ?? staged.stderr);
  process.exit(1);
}

const affected = staged.stdout
  .split('\0')
  .some(
    (file) =>
      /(^|\/)AGENTS\.md$/.test(file) ||
      /^(docs\/.*\.md|\.agents\/(notes|skills)\/)/.test(file) ||
      /^(package(-lock)?\.json|lefthook\.yml|scripts\/README\.md)$/.test(file) ||
      /^scripts\/(check-agent-contracts(?:\.test)?\.mjs|git\/)/.test(file),
  );

if (affected) {
  process.stdout.write('Validating governance in the current worktree for staged changes.\n');
  const result = spawn.sync('npm', ['run', 'check:agent-contracts'], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(
      'Agent contracts failed. Run npm run check:agent-contracts and fix the reported errors.\n',
    );
    process.exitCode = result.status ?? 1;
  }
} else {
  process.stdout.write('No staged governance changes; agent contracts skipped.\n');
}
