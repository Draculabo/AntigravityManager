import fs from 'node:fs/promises';
import path from 'node:path';

/** Both diagnostic workers are mandatory even when their features start disabled. */
export async function assertCoreRuntimeResources(directory: string): Promise<void> {
  for (const entry of ['traffic-audit.worker.js', 'thought-store.worker.js']) {
    const file = await fs.stat(path.join(directory, entry));
    if (!file.isFile()) {
      throw new Error('Required standalone worker resource is not a file');
    }
  }
}
