import path from 'path';

import {
  isDurableStoreTestEnvironment,
  readPositiveIntegerEnv,
} from '@/shared/persistence/durable-store-settings';
import { getProxyStateDir } from '@/shared/platform/paths';
import {
  DEFAULT_BATCH_CONCURRENCY,
  DEFAULT_BATCH_TTL_MS,
  DEFAULT_MAX_BATCHES,
  DEFAULT_MAX_REQUESTS_PER_BATCH,
  type BatchRunnerOptions,
} from './batch-job.types';

export const BATCH_RUNNER_STATE_FILENAME = 'proxy-batches.json';

/**
 * Where batch state lives: `<proxy-state>/proxy-batches.json`, beside the
 * other durable proxy state, written through the same atomic helper every
 * other durable-state owner on this base uses.
 *
 * Under the test runner no path is returned at all, so a unit test can never
 * write into the real data directory; tests that need a file pass one in.
 */
export function resolveBatchRunnerOptions(): BatchRunnerOptions {
  return {
    ...(isDurableStoreTestEnvironment()
      ? {}
      : { filePath: path.join(getProxyStateDir(), BATCH_RUNNER_STATE_FILENAME) }),
    maxConcurrency: readPositiveIntegerEnv('AGM_BATCH_MAX_CONCURRENCY', DEFAULT_BATCH_CONCURRENCY),
    ttlMs: readPositiveIntegerEnv('AGM_BATCH_TTL_MS', DEFAULT_BATCH_TTL_MS),
    maxBatches: readPositiveIntegerEnv('AGM_BATCH_MAX_BATCHES', DEFAULT_MAX_BATCHES),
    maxRequestsPerBatch: readPositiveIntegerEnv(
      'AGM_BATCH_MAX_REQUESTS',
      DEFAULT_MAX_REQUESTS_PER_BATCH,
    ),
  };
}
