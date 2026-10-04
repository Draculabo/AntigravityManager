import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCoreRuntimeResources } from '@/core/runtime-resources';

describe('standalone worker admission', () => {
  const directories: string[] = [];
  afterEach(async () => {
    const parent = await fs.realpath(os.tmpdir());
    for (const directory of directories.splice(0)) {
      if (
        path.dirname(await fs.realpath(directory)) !== parent ||
        !path.basename(directory).startsWith('agm-worker-resources-')
      ) {
        throw new Error('Unexpected test cleanup target');
      }
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it('rejects an incomplete resource set before owner startup', async () => {
    const directory = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), 'agm-worker-resources-'),
    );
    directories.push(directory);
    await fs.writeFile(path.join(directory, 'traffic-audit.worker.js'), '');
    await expect(assertCoreRuntimeResources(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.mkdir(path.join(directory, 'thought-store.worker.js'));
    await expect(assertCoreRuntimeResources(directory)).rejects.toThrow('not a file');
    await fs.rmdir(path.join(directory, 'thought-store.worker.js'));
    await fs.writeFile(path.join(directory, 'thought-store.worker.js'), '');
    await expect(assertCoreRuntimeResources(directory)).resolves.toBeUndefined();
  });
});
