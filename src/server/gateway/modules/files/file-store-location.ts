import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isDurableStoreTestEnvironment } from '@/shared/persistence/durable-store-settings';
import { getAgentDir } from '@/shared/platform/paths';

import type { FileStoreOptions } from './file-store.types';

/**
 * Where the file store lives: `<agent dir>/proxy-files`, beside the other state
 * this app keeps, and resolved without Electron so the proxy can be started
 * headless.
 *
 * Under the test runner it moves to a temp directory, so no unit test can write
 * into the real one. Tests that care about the contents pass an explicit root.
 */
export function resolveFileStoreOptions(): FileStoreOptions {
  return {
    rootDirectory: isDurableStoreTestEnvironment()
      ? join(tmpdir(), 'antigravity-manager-test', 'proxy-files')
      : join(getAgentDir(), 'proxy-files'),
  };
}
