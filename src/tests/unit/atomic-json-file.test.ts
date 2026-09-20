import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAtomicFileWriter,
  writeFileAtomic,
  writeFileAtomicSync,
} from '@/shared/persistence/atomic-json-file';

type FailureStage = 'write' | 'sync' | 'rename' | 'directory-sync' | null;

function createWriter(platform: 'linux' | 'win32', failure: FailureStage = null) {
  const events: string[] = [];
  const primaryError = new Error(`${failure ?? 'unexpected'} failure`);
  const fileHandle = {
    async writeFile(_content: string | Uint8Array): Promise<void> {
      events.push('write-file');
      if (failure === 'write') {
        throw primaryError;
      }
    },
    async sync(): Promise<void> {
      events.push('sync-file');
      if (failure === 'sync') {
        throw primaryError;
      }
    },
    async close(): Promise<void> {
      events.push('close-file');
    },
  };
  const directoryHandle = {
    async writeFile(_content: string | Uint8Array): Promise<void> {
      throw new Error('directories must not be written');
    },
    async sync(): Promise<void> {
      events.push('sync-directory');
      if (failure === 'directory-sync') {
        throw primaryError;
      }
    },
    async close(): Promise<void> {
      events.push('close-directory');
    },
  };

  const writer = createAtomicFileWriter({
    platform,
    async mkdir(_directory: string): Promise<void> {
      events.push('mkdir');
    },
    async openFile(_filePath: string, _mode?: number) {
      events.push('open-file');
      return fileHandle;
    },
    async rename(_temporaryPath: string, _filePath: string): Promise<void> {
      events.push('rename');
      if (failure === 'rename') {
        throw primaryError;
      }
    },
    async remove(_temporaryPath: string): Promise<void> {
      events.push('remove');
    },
    async openDirectory(_directory: string) {
      events.push('open-directory');
      return directoryHandle;
    },
  });

  return { events, primaryError, writer };
}

describe('atomic file persistence', () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 20 });
    }
  });

  it('writes, syncs, closes, replaces, then syncs the parent directory on POSIX', async () => {
    const { events, writer } = createWriter('linux');

    await writer.write('/state/config.json', '{"version":1}');

    expect(events).toEqual([
      'mkdir',
      'open-file',
      'write-file',
      'sync-file',
      'close-file',
      'rename',
      'open-directory',
      'sync-directory',
      'close-directory',
    ]);
  });

  it('skips parent-directory sync on Windows while retaining file sync and replacement', async () => {
    const { events, writer } = createWriter('win32');

    await writer.write('C:\\state\\config.json', '{"version":1}');

    expect(events).toEqual([
      'mkdir',
      'open-file',
      'write-file',
      'sync-file',
      'close-file',
      'rename',
    ]);
  });

  it.each([
    ['write', ['mkdir', 'open-file', 'write-file', 'close-file', 'remove']],
    ['sync', ['mkdir', 'open-file', 'write-file', 'sync-file', 'close-file', 'remove']],
    ['rename', ['mkdir', 'open-file', 'write-file', 'sync-file', 'close-file', 'rename', 'remove']],
    [
      'directory-sync',
      [
        'mkdir',
        'open-file',
        'write-file',
        'sync-file',
        'close-file',
        'rename',
        'open-directory',
        'sync-directory',
        'close-directory',
        'remove',
      ],
    ],
  ] as const)(
    'preserves the primary %s failure and cleans the temporary file',
    async (failure, expectedEvents) => {
      const { events, primaryError, writer } = createWriter('linux', failure);

      await expect(writer.write('/state/config.json', '{"version":1}')).rejects.toBe(primaryError);
      expect(events).toEqual(expectedEvents);
    },
  );

  it('replaces an existing target without a temporary file left behind on the real filesystem', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-atomic-file-'));
    directories.push(directory);
    const filePath = path.join(directory, 'config.json');
    fs.writeFileSync(filePath, 'old', 'utf8');

    await writeFileAtomic(filePath, 'new');

    expect(fs.readFileSync(filePath, 'utf8')).toBe('new');
    expect(fs.readdirSync(directory)).toEqual(['config.json']);
  });

  it('syncs the synchronous writer before account-index style replacement', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-atomic-file-sync-'));
    directories.push(directory);
    const filePath = path.join(directory, 'accounts.json');
    const sync = vi.spyOn(fs, 'fsyncSync');

    writeFileAtomicSync(filePath, '{"version":1}\n');

    expect(sync).toHaveBeenCalled();
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"version":1}\n');
    expect(fs.readdirSync(directory)).toEqual(['accounts.json']);
  });
});
