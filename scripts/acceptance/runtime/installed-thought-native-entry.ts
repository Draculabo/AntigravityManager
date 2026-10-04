import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_APP_CONFIG } from '../../../src/modules/config/types';
import { getProxyStateDir } from '../../../src/shared/platform/paths';
import { ThoughtStoreRepository } from '../../../src/modules/proxy-gateway/thought-store/thought-store.repository';
import { ThoughtRecordSummaryListSchema } from '../../../src/modules/proxy-gateway/thought-store/thought-store.types';
import {
  LARGE_THOUGHT_BYTES,
  LARGE_THOUGHT_SESSION,
  LARGE_THOUGHT_SIGNATURE,
} from './fixtures/thought-capacity';

async function seed(): Promise<void> {
  const home = process.env.AGM_DIAGNOSTIC_TEST_HOME;
  assert(home);
  assert.equal(path.resolve(os.homedir()), path.resolve(home));
  const directory = getProxyStateDir();
  assert(directory.startsWith(`${home}${path.sep}`));
  await fs.mkdir(directory, { recursive: true });
  // Seed valid persisted data through its owning repository. Model-write backpressure is a
  // separate contract; this acceptance exercises reading an existing near-limit record.
  const store = new ThoughtStoreRepository(path.join(directory, 'thinking-store.db'));
  try {
    store.execute({
      operation: 'save',
      payload: {
        createdAt: Date.now(),
        fingerprint: 'installed-capacity-fixture',
        model: 'gemini-pro',
        sourceFamily: 'gemini-pro',
        signature: LARGE_THOUGHT_SIGNATURE,
        thought: 'T'.repeat(LARGE_THOUGHT_BYTES),
        toolIds: [],
        toolNames: [],
        visible: '',
        meaningful: true,
        sessionKey: LARGE_THOUGHT_SESSION,
        maxSessionBytes: DEFAULT_APP_CONFIG.proxy.thought_store.max_session_mib * 1024 * 1024,
        maxSessions: DEFAULT_APP_CONFIG.proxy.thought_store.max_sessions,
        maxTurns: DEFAULT_APP_CONFIG.proxy.thought_store.max_turns_per_session,
      },
    });
    const records = ThoughtRecordSummaryListSchema.parse(
      store.execute({ operation: 'listRecords', payload: { sessionKey: LARGE_THOUGHT_SESSION } }),
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].oversized, false);
  } finally {
    store.execute({ operation: 'shutdown', payload: null });
  }
  process.stdout.write(`Native Thought fixture persisted ${LARGE_THOUGHT_BYTES} bytes.\n`);
}
void seed().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
