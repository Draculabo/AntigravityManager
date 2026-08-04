import { spawn } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { createNpmInvocation } from '../../../scripts/start-performance-recorder.mjs';

interface NpmInvocation {
  arguments: string[];
  command: string;
}

function executeInvocation(
  invocation: NpmInvocation,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      env: process.env,
      windowsHide: true,
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({ code, stdout: stdout.trim() });
    });
  });
}

describe('start performance recorder script', () => {
  test.runIf(process.platform === 'win32')('launches npm on Windows', async () => {
    const result = await executeInvocation(createNpmInvocation('win32', ['--version']));

    expect(result).toEqual({
      code: 0,
      stdout: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    });
  });
});
