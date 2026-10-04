import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createAcceptanceCommand } from './run.mjs';

test('dispatcher preserves option order, delimiters and paths with spaces for a single selected check', async () => {
  const calls = [];
  await createAcceptanceCommand((args) => calls.push(args)).parseAsync(
    ['runtime', 'bootstrap', '--runtime-root', 'C:\\test runtime', '--', '--help'],
    { from: 'user' },
  );
  assert.deepEqual(calls, [
    [
      fileURLToPath(new URL('./runtime/core-bootstrap-native.mjs', import.meta.url)),
      '--runtime-root',
      'C:\\test runtime',
      '--',
      '--help',
    ],
  ]);
});

test('every listed specialized check resolves to an existing script', async () => {
  const calls = [];
  const program = createAcceptanceCommand((args) => calls.push(args));
  for (const command of program.commands.filter((command) => command.name() !== 'unit')) {
    for (const check of command.registeredArguments[0].argChoices) {
      await program.parseAsync([command.name(), check], { from: 'user' });
    }
  }
  for (const args of calls) {
    assert.equal(args.length, 1);
    await access(args[0]);
  }
});

test('unit mode selects only pure suites and unknown checks never start a subprocess', async () => {
  const calls = [];
  const program = createAcceptanceCommand((args) => calls.push(args))
    .exitOverride()
    .configureOutput({ writeErr: () => {} });
  for (const command of program.commands) {
    command.exitOverride().configureOutput({ writeErr: () => {} });
  }
  await program.parseAsync(['unit'], { from: 'user' });
  const [args] = calls;
  assert.equal(args[0], '--test');
  assert(args.length > 1);
  assert(
    args.slice(1).every((file) => file.endsWith('.test.mjs') && !file.includes('-native.test.mjs')),
  );
  for (const file of args.slice(1)) {
    await access(file);
  }
  await assert.rejects(
    program.parseAsync(['runtime', 'unknown'], { from: 'user' }),
    (error) => error.code === 'commander.invalidArgument',
  );
  assert.equal(calls.length, 1);
});
