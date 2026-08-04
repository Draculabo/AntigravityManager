import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createNpmInvocation(platform, npmArguments) {
  if (platform === 'win32') {
    // Node 22 rejects direct spawning of the npm.cmd shim with EINVAL, so invoke it through cmd.exe.
    return {
      arguments: ['/d', '/s', '/c', ['npm.cmd', ...npmArguments].join(' ')],
      command: process.env.ComSpec ?? 'cmd.exe',
    };
  }

  return {
    arguments: npmArguments,
    command: 'npm',
  };
}

export function startPerformanceRecorder() {
  const outputDirectory = resolve(
    process.env.ANTIGRAVITY_PERFORMANCE_OUTPUT_DIR ?? 'test-results/performance',
  );
  const invocation = createNpmInvocation(process.platform, ['start']);
  const child = spawn(invocation.command, invocation.arguments, {
    env: {
      ...process.env,
      ANTIGRAVITY_ENABLE_PERFORMANCE_RECORDER: '1',
      ANTIGRAVITY_PERFORMANCE_DEBUG_PORT: process.env.ANTIGRAVITY_PERFORMANCE_DEBUG_PORT ?? '9333',
      ANTIGRAVITY_PERFORMANCE_OUTPUT_DIR: outputDirectory,
    },
    stdio: 'inherit',
    windowsHide: true,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startPerformanceRecorder();
}
