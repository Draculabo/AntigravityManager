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
      /^(package\.json|pnpm-(lock|workspace)\.yaml|\.nvmrc|\.npmrc|lefthook\.yml|scripts\/README\.md)$/.test(
        file,
      ) ||
      /^scripts\/(check-agent-contracts(?:\.test)?\.mjs|agent-document-lifecycle(?:\.test)?\.mjs|git\/|quality\/)/.test(
        file,
      ) ||
      /^\.github\/workflows\/(testing|lint|format)\.yaml$/.test(file),
  );

if (affected) {
  process.stdout.write('Validating governance in the current worktree for staged changes.\n');
  for (const script of ['check:agent-contracts', 'check:quality']) {
    const result = spawn.sync('pnpm', ['run', script], {
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.error || result.signal || result.status !== 0) {
      process.stderr.write(
        `Governance check failed. Run pnpm run ${script} and fix the reported errors.\n`,
      );
      process.exitCode = result.status || 1;
      break;
    }
  }
} else {
  process.stdout.write('No staged governance changes; agent contracts skipped.\n');
}
