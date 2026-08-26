import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNpmInvocation } from './start-performance-recorder.mjs';

function executeInvocation(invocation, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      env: environment,
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

test(
  'executes the Windows npm invocation through a real command shell',
  { skip: process.platform !== 'win32' },
  async (context) => {
    const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'agm-npm-shim-'));
    context.after(async () => rm(fixtureDirectory, { recursive: true, force: true }));
    await writeFile(path.join(fixtureDirectory, 'npm.cmd'), '@echo off\r\necho 10.99.0\r\n');

    const result = await executeInvocation(createNpmInvocation('win32', ['--version']), {
      ...process.env,
      PATH: `${fixtureDirectory};${process.env.PATH ?? ''}`,
    });

    assert.deepEqual(result, { code: 0, stdout: '10.99.0' });
  },
);
