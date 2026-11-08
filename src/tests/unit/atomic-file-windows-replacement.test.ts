import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAtomicFileWriter } from '@/shared/persistence/atomic-json-file';

function fixture(platform: NodeJS.Platform = 'win32') {
  const handle = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const dependencies = {
    platform,
    mkdir: vi.fn().mockResolvedValue(undefined),
    openFile: vi.fn().mockResolvedValue(handle),
    rename: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    openDirectory: vi.fn().mockResolvedValue(handle),
  };
  return { writer: createAtomicFileWriter(dependencies), dependencies, handle };
}

let directory = '';
afterEach(() => {
  vi.restoreAllMocks();
  if (directory) {
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('agm-replace-')
    ) {
      throw new Error('Unsafe replacement fixture cleanup');
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    directory = '';
  }
});

describe('bounded Windows atomic replacement recovery', () => {
  it('rechecks owner revocation before a Windows rename retry and preserves the pending target', async () => {
    const { writer, dependencies, handle } = fixture();
    dependencies.rename.mockRejectedValueOnce(Object.assign(new Error('sharing conflict'), { code: 'EPERM' }));
    const revoked = new Error('export revoked');
    const guard = vi.fn().mockImplementationOnce(() => undefined).mockImplementation(() => { throw revoked; });
    await expect(writer.write('/fixture/diagnostic.txt', 'complete', { beforeCommit: guard })).rejects.toBe(revoked);
    expect(dependencies.rename).toHaveBeenCalledOnce();
    expect(guard).toHaveBeenCalledTimes(2);
    expect(handle.writeFile).toHaveBeenCalledOnce();
    expect(dependencies.remove).toHaveBeenCalledOnce();
  });
  it('retries the same completed temporary file after EPERM without writing or syncing again', async () => {
    const { writer, dependencies, handle } = fixture();
    const blocked = Object.assign(new Error('Synthetic sharing conflict'), { code: 'EPERM' });
    dependencies.rename.mockRejectedValueOnce(blocked).mockRejectedValueOnce(blocked);
    await writer.write('/fixture/state.json', 'new');
    expect(dependencies.rename.mock.calls).toHaveLength(3);
    const first = dependencies.rename.mock.calls[0];
    expect(dependencies.rename.mock.calls).toEqual([first, first, first]);
    expect(handle.writeFile.mock.calls).toEqual([['new']]);
    expect(handle.sync).toHaveBeenCalledOnce();
    expect(handle.close).toHaveBeenCalledOnce();
    expect(dependencies.remove).not.toHaveBeenCalled();
  });

  it('stops after five failed replacements, preserves the final error and cleans only the temporary file', async () => {
    const { writer, dependencies, handle } = fixture();
    const blocked = Object.assign(new Error('Synthetic permanent denial'), { code: 'EPERM' });
    const finalFailure = Object.assign(new Error('Synthetic final denial'), { code: 'EPERM' });
    dependencies.rename
      .mockRejectedValueOnce(blocked)
      .mockRejectedValueOnce(blocked)
      .mockRejectedValueOnce(blocked)
      .mockRejectedValueOnce(blocked)
      .mockRejectedValue(finalFailure);
    await expect(writer.write('/fixture/state.json', 'new')).rejects.toBe(finalFailure);
    expect(dependencies.rename).toHaveBeenCalledTimes(5);
    expect(dependencies.remove.mock.calls).toEqual([[dependencies.rename.mock.calls[0][0]]]);
    expect(handle.writeFile).toHaveBeenCalledOnce();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['linux', 'EPERM'],
    ['darwin', 'EPERM'],
    ['win32', 'EACCES'],
    ['win32', 'ENOENT'],
  ] as const)('does not retry %s %s', async (platform, code) => {
    const { writer, dependencies } = fixture(platform);
    const denied = Object.assign(new Error('Synthetic nonrecoverable replacement error'), { code });
    dependencies.rename.mockRejectedValue(denied);
    await expect(writer.write('/fixture/state.json', 'new')).rejects.toBe(denied);
    expect(dependencies.rename).toHaveBeenCalledOnce();
    expect(dependencies.remove.mock.calls).toEqual([[dependencies.rename.mock.calls[0][0]]]);
  });

  it('leaves the old target intact on exhausted Windows replacement failure using actual temporary files', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-replace-'));
    const filePath = path.join(directory, 'state.json');
    fs.writeFileSync(filePath, 'old');
    const failure = Object.assign(new Error('Synthetic replacement denied'), { code: 'EPERM' });
    const rename = vi.fn().mockRejectedValue(failure);
    const writer = createAtomicFileWriter({
      platform: 'win32',
      mkdir: async (dir) => {
        await fs.promises.mkdir(dir, { recursive: true });
      },
      openFile: (file) => fs.promises.open(file, 'wx'),
      rename,
      remove: (file) => fs.promises.rm(file, { force: true }),
      openDirectory: (dir) => fs.promises.open(dir, 'r'),
    });
    await expect(writer.write(filePath, 'new')).rejects.toBe(failure);
    expect(rename).toHaveBeenCalledTimes(5);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('old');
    expect(fs.readdirSync(directory)).toEqual(['state.json']);
  });
});
