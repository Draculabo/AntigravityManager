import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BoundedSqliteWorker } from '@/shared/persistence/sqlite-worker/bounded-sqlite-worker';

describe('production Thought Worker mutation ordering', () => {
  it.skipIf(process.versions.electron === undefined)(
    'drains old accepted writes before deletion while preserving unrelated admission and reopen',
    async () => {
      const workerPath = process.env.AGM_THOUGHT_WORKER_ENTRY;
      if (!workerPath || !fs.existsSync(workerPath)) {
        throw new Error('Set AGM_THOUGHT_WORKER_ENTRY to the rebuilt production Worker');
      }
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-thought-lifetime-'));
      const databasePath = path.join(directory, 'thinking.db');
      const create = () =>
        new BoundedSqliteWorker({
          databasePath,
          maxPendingBytes: 128 * 1024 * 1024,
          maxPendingCommands: 256,
          name: 'thought-lifetime-fixture',
          workerPath,
        });
      let owner = create();
      const failed = vi.fn();
      const payload = (sessionKey: string, fingerprint: string) => ({
        createdAt: Date.now(),
        sessionKey,
        fingerprint,
        maxSessionBytes: 64 * 1024 * 1024,
        maxSessions: 2000,
        maxTurns: 600,
        meaningful: true,
        model: 'gemini-pro',
        signature: null,
        partSignatures: [],
        sourceFamily: 'gemini',
        thought: fingerprint,
        visible: '',
        toolIds: [],
        toolNames: [],
      });
      try {
        await owner.request({ operation: 'stats', payload: null });
        expect(
          owner.tryWrite(
            { operation: 'save', payload: payload('deleted', 'old-a') },
            { priority: 'model', onFailure: failed },
          ),
        ).toBe(true);
        expect(
          owner.tryWrite(
            { operation: 'save', payload: payload('deleted', 'old-b') },
            { priority: 'model', onFailure: failed },
          ),
        ).toBe(true);
        const oldSettled = owner.drainAdmitted();
        expect(
          owner.tryWrite(
            { operation: 'save', payload: payload('unrelated', 'kept') },
            { priority: 'model', onFailure: failed },
          ),
        ).toBe(true);
        await oldSettled;
        expect(
          await owner.request({ operation: 'deleteSession', payload: { sessionKey: 'deleted' } }),
        ).toEqual({ sessions: 1, records: 2 });
        await owner.drainAdmitted();
        expect(
          await owner.request({ operation: 'getSession', payload: { sessionKey: 'deleted' } }),
        ).toEqual([]);
        expect(
          await owner.request({ operation: 'getSession', payload: { sessionKey: 'unrelated' } }),
        ).toMatchObject([{ thought: 'kept' }]);
        expect(failed).not.toHaveBeenCalled();
        await owner.close();
        owner = create();
        expect(
          await owner.request({ operation: 'getSession', payload: { sessionKey: 'deleted' } }),
        ).toEqual([]);
        expect(
          await owner.request({ operation: 'getSession', payload: { sessionKey: 'unrelated' } }),
        ).toMatchObject([{ thought: 'kept' }]);
      } finally {
        await owner.close();
        const target = path.resolve(directory);
        expect(path.dirname(target)).toBe(path.resolve(os.tmpdir()));
        expect(path.basename(target).startsWith('agm-thought-lifetime-')).toBe(true);
        fs.rmSync(target, { recursive: true, force: true });
      }
    },
    30000,
  );
});
