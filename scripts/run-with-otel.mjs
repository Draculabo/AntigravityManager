import spawn from 'cross-spawn';

const args = process.argv.slice(2);
const separatorIndex = args.indexOf('--');
const mode = (separatorIndex >= 0 ? args[0] : args[0]) || 'console';
const optionArgs = separatorIndex >= 0 ? args.slice(1, separatorIndex) : args.slice(1);
const commandArgs = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : ['pnpm', 'start'];

function readOption(name) {
  const prefix = `${name}=`;
  const inline = optionArgs.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = optionArgs.indexOf(name);
  if (index >= 0 && optionArgs[index + 1]) {
    return optionArgs[index + 1];
  }

  return '';
}

function getCommand() {
  const [rawCommand, ...rawArgs] = commandArgs;
  if (!rawCommand) {
    return { command: 'pnpm', args: ['start'] };
  }

  return {
    command: rawCommand,
    args: rawArgs,
  };
}

function getOtelEnv() {
  if (mode === 'off' || mode === 'disabled') {
    return {
      OTEL_SDK_DISABLED: 'true',
    };
  }

  if (mode === 'console') {
    return {
      OTEL_TRACES_EXPORTER: 'console',
      OTEL_METRICS_EXPORTER: 'console',
    };
  }

  if (mode === 'otlp') {
    const endpoint = readOption('--endpoint') || 'http://localhost:4318';
    return {
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    };
  }

  console.error(`Unknown OpenTelemetry mode: ${mode}`);
  console.error('Expected one of: console, otlp, off');
  process.exit(1);
}

const { command, args: childArgs } = getCommand();
const child = spawn(command, childArgs, {
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    ...getOtelEnv(),
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
