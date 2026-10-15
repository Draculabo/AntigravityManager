import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Argument, Command } from 'commander';
import spawn from 'cross-spawn';
import { ADDITIONAL_CHECKS, selectChecks, SELECTIONS } from './checks.mjs';

/** Execute sequentially so a failed prerequisite prevents dependent checks from starting. */
export function runChecks(checks, cwd = process.cwd()) {
  const results = [];
  for (const check of checks) {
    const args = ['run', check.script, ...(check.args.length ? ['--', ...check.args] : [])];
    console.log(`\n[quality] npm ${args.join(' ')}`);
    const started = performance.now();
    const child = spawn.sync('npm', args, { cwd, stdio: 'inherit', windowsHide: true });
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
          `npm run ${check.script}${check.args.length ? ` -- ${check.args.join(' ')}` : ''}\n  ${check.description}`,
        );
      }
      if (selection === 'all') {
        console.log('\nAdditional entry points (not separate CI checks):');
        for (const [script, reason] of Object.entries(ADDITIONAL_CHECKS)) {
          console.log(`npm run ${script}\n  ${reason}`);
        }
      }
      return;
    }
    const results = runChecks(checks);
    console.log(`\n[quality] Results:\n${JSON.stringify(results, null, 2)}`);
    if (results.some((result) => result.status !== 'passed')) {
      process.exitCode = 1;
    }
  });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await program.parseAsync(process.argv);
}
