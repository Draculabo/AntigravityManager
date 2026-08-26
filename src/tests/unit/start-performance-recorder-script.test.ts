import { describe, expect, test } from 'vitest';
import { createNpmInvocation } from '../../../scripts/start-performance-recorder.mjs';

describe('start performance recorder script', () => {
  test('routes npm.cmd through the Windows command shell', () => {
    expect(createNpmInvocation('win32', ['--version'])).toEqual({
      arguments: ['/d', '/s', '/c', 'npm.cmd --version'],
      command: process.env.ComSpec ?? 'cmd.exe',
    });
  });
});
