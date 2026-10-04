import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Argument, Command } from 'commander';
import spawn from 'cross-spawn';

const suites = {
  runtime: {
    bootstrap: './runtime/core-bootstrap-native.mjs',
    diagnostics: './runtime/diagnostics-terminal-native.mjs',
    installed: './runtime/installed-runtime-native.mjs',
    desktop: './runtime/packaged-desktop-native.mjs',
  },
  installers: {
    msi: './installers/installed-msi-native.mjs',
    'squirrel-upgrade': './installers/installed-squirrel-upgrade.mjs',
    'squirrel-updater': './installers/packaged-squirrel-updater-native.mjs',
    'nsis-updater': './installers/packaged-nsis-updater-native.mjs',
    feed: './installers/prepare-windows-update-feed.test.mjs',
  },
  accounts: {
    prepare: './accounts/build-helpers.mjs',
    switch: './accounts/account-switch-acceptance.mjs',
    'auth-state': './accounts/client-ui.integration.mjs',
    'graceful-close': './accounts/test-windows-graceful-close.integration.mjs',
    history: './accounts/test-official-ide-history.integration.mjs',
  },
  agents: {
    configure: './agents/coding-tool-configuration-acceptance.mjs',
    task: './agents/live-agent-acceptance.mjs',
    electron: './agents/electron-runner.mjs',
    report: './agents/aggregate.mjs',
  },
  multimodal: {
    request: './multimodal/live-multimodal-acceptance.mjs',
    electron: './agents/electron-runner.mjs',
  },
  thinking: {
    request: './thinking/live-thinking-acceptance.mjs',
    electron: './agents/electron-runner.mjs',
  },
  development: {
    connection: '../development/test-vite-development-connection.integration.mjs',
  },
};

const unitFiles = [
  '../build/trace-standalone-runtime.test.mjs',
  './installers/prepare-windows-update-feed.test.mjs',
  './accounts/official-auth-state.test.mjs',
  './agents/clients.test.mjs',
  './agents/audit-window.test.mjs',
  './agents/summarize.test.mjs',
  './agents/aggregate.test.mjs',
  './multimodal/live-multimodal-acceptance.test.mjs',
  './thinking/protocols.test.mjs',
  './helpers/native-fixture.test.mjs',
  './run.test.mjs',
];

const scriptPath = (file) => fileURLToPath(new URL(file, import.meta.url));

export function createAcceptanceCommand(execute = runNode) {
  const program = new Command()
    .name('acceptance')
    .description(
      'Select one acceptance check; live and installer checks require prepared environments.',
    )
    .enablePositionalOptions();
  program
    .command('unit')
    .description('Run local harness tests without providers, windows or installers.')
    .action(() => execute(['--test', ...unitFiles.map(scriptPath)]));
  for (const [suite, checks] of Object.entries(suites)) {
    program
      .command(suite)
      .description(`Available checks: ${Object.keys(checks).join(', ')}.`)
      .addArgument(new Argument('<check>').choices(Object.keys(checks)))
      .argument('[arguments...]', 'Arguments passed unchanged to the selected check')
      .passThroughOptions()
      .action((check, args) => execute([scriptPath(checks[check]), ...args]));
  }
  return program;
}

async function runNode(args) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  const [code, signal] = await once(child, 'exit');
  process.exitCode = code ?? 1;
  if (signal) {
    process.stderr.write(`Acceptance check ended with signal ${signal}.\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await createAcceptanceCommand().parseAsync(process.argv);
}
