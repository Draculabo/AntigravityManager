import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Argument, Command } from 'commander';
import spawn from 'cross-spawn';
import { ADDITIONAL_CHECKS, selectChecks, SELECTIONS } from './checks.mjs';
import { profileChecks, resolveProfile } from './profile.mjs';

/** Execute sequentially so a failed prerequisite prevents dependent checks from starting. */
export function runChecks(checks, cwd = process.cwd()) {
  const results = [];
  for (const check of checks) {
    if (check.skip) {
      results.push({ script: check.script, status: 'skipped', reason: 'Documentation-only PR.' });
      continue;
    }
    const args = ['run', check.script, ...check.args];
    console.log(`\n[quality] pnpm ${args.join(' ')}`);
    const started = performance.now();
    const child = spawn.sync('pnpm', args, { cwd, stdio: 'inherit', windowsHide: true });
    const status = child.error || child.signal || child.status !== 0 ? 'failed' : 'passed';
    results.push({
      script: check.script,
      status,
      exitCode: child.status,
      signal: child.signal,
      durationMs: Math.round(performance.now() - started),
    });
    if (status === 'failed') {
      console.error(child.error?.message ?? `[quality] ${check.script} ended unsuccessfully.`);
      break;
    }
  }
  const completed = new Set(results.map((result) => result.script));
  for (const check of checks) {
    if (!completed.has(check.script)) {
      results.push({ script: check.script, status: 'not-run' });
    }
  }
  return results;
}

const program = new Command()
  .name('quality')
  .description('Run the shared local/CI check selection; full selections may be expensive.')
  .addArgument(new Argument('[selection]').choices(SELECTIONS).default('all'))
  .option('--list', 'List selected commands and their purpose without executing them')
  .action((selection, options) => {
    const checks = selectChecks(selection);
    if (options.list) {
      for (const check of checks) {
        console.log(
          `pnpm run ${check.script}${check.args.length ? ` ${check.args.join(' ')}` : ''}\n  ${check.description}`,
        );
      }
      if (selection === 'all') {
        console.log('\nAdditional entry points (not separate CI checks):');
        for (const [script, reason] of Object.entries(ADDITIONAL_CHECKS)) {
          console.log(`pnpm run ${script}\n  ${reason}`);
        }
      }
      return;
    }
    const { profile, reason } = resolveProfile();
    console.log(`[quality] Profile: ${profile}. ${reason}`);
    const results = runChecks(profileChecks(checks, profile));
    console.log(`\n[quality] Results:\n${JSON.stringify(results, null, 2)}`);
    if (results.some((result) => !['passed', 'skipped'].includes(result.status))) {
      process.exitCode = 1;
    }
  });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await program.parseAsync(process.argv);
}
