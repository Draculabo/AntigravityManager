import { describe, expect, test } from 'vitest';
import { createPnpmInvocation } from '../../../scripts/start-performance-recorder.mjs';

describe('start performance recorder script', () => {
  test('routes pnpm.cmd through the Windows command shell', () => {
    expect(createPnpmInvocation('win32', ['--version'])).toEqual({
      arguments: ['/d', '/s', '/c', 'pnpm.cmd --version'],
      command: process.env.ComSpec ?? 'cmd.exe',
    });
  });
});
