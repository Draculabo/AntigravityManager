import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
// Read-only checks must leave partially staged work intact instead of hiding it in a stash.
if (args[0] === 'run' && args[1] === 'pre-commit') {
  args.push('--no-stage-fixed');
}
// Type checking applies to every push, including invocations with no changed file list.
if (args[0] === 'run' && args[1] === 'pre-push') {
  args.push('--force');
}
const result = spawnSync(process.execPath, [require.resolve('lefthook'), ...args], {
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
