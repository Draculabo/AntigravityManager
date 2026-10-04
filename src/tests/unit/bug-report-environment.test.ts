import { call } from '@orpc/server';
import { release, version } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { bugReportEnvironment } from '@/modules/app-shell/ipc/app/handlers';

vi.mock('electron', () => ({ app: { getVersion: () => '0.17.1' } }));

describe('bug-report environment IPC', () => {
  it('returns only software and platform information, without machine or account identifiers', async () => {
    expect(await call(bugReportEnvironment, undefined)).toEqual({
      appVersion: '0.17.1',
      platform: process.platform,
      osVersion: `${version()} (${release()})`,
      architecture: process.arch,
      electronVersion: process.versions.electron ?? 'Unavailable',
      nodeVersion: process.versions.node,
    });
  });
});
