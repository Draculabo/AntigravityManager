import { responsesIdentityFixture } from './responses-identity.fixture';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { OpenAIResponsesSessionStoreImpl } from '@/server/gateway/modules/openai/responses/openai-responses-session.store';
import { OPENAI_RESPONSES_SESSION_FILENAME } from '@/server/gateway/modules/openai/responses/openai-responses-session.service';
import { resolveResponsesHistoryOwner } from '@/server/gateway/modules/openai/responses/responses-history-owner';
import * as atomic from '@/shared/persistence/atomic-json-file';
import { logger } from '@/shared/logging/logger';

let folder: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (folder) {
    if (
      path.dirname(path.resolve(folder)) !== path.resolve(os.tmpdir()) ||
      !path.basename(folder).startsWith('agm-owner-write-')
    ) {
      throw new Error('Unsafe write fixture cleanup');
    }
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    folder = undefined;
  }
});

describe('Owned Responses history terminal-state publication', () => {
  it.each(['cancel', 'fail'] as const)(
    'does not publish a %s request as completed history',
    async (mode) => {
      const store = new OpenAIResponsesSessionStoreImpl();
      let release!: (value: unknown) => void;
      let fail!: (error: Error) => void;
      const pending = new Promise((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
      const dispatch = vi.fn().mockReturnValue(pending);
      const operations = new OpenAIOperations(
        { handleChatCompletions: dispatch } as never,
        undefined,
        undefined,
        store,
      );
      const requestRaw = new EventEmitter();
      const replyRaw = Object.assign(new EventEmitter(), { writableEnded: false });
      const reply = {
        raw: replyRaw,
        status: vi.fn().mockReturnThis(),
        header: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      };
      const work = operations.responses(
        { model: 'gemini-3-flash', input: 'Synthetic task' },
        reply as never,
        {
          headers: { 'x-api-key': 'synthetic-owner-a' },
          raw: requestRaw,
          url: '/v1/responses',
        } as never,
      );
      // File-reference expansion yields before dispatch; wait for the actual owner boundary.
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      const id: string = dispatch.mock.calls[0][3].responseId;
      if (mode === 'cancel') {
        requestRaw.emit('aborted');
        expect(dispatch.mock.calls[0][2].aborted).toBe(true);
        release({
          id: 'chat_fixture',
          model: 'gemini-3-flash',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Late answer' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      } else {
        fail(new Error('Synthetic upstream failure'));
      }
      await work;
      expect(store.get(id)).toBeNull();
      expect(store.getHistoryOwner(id)).toBeNull();
      expect(requestRaw.listenerCount('aborted')).toBe(0);
      expect(replyRaw.listenerCount('close')).toBe(0);
    },
  );

  it('preserves old bytes when replacement fails and does not claim persistence', async () => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-owner-write-'));
    const filePath = path.join(folder, OPENAI_RESPONSES_SESSION_FILENAME);
    const old = JSON.stringify({
      version: 1,
      entries: [
        {
          key: 'resp_legacy',
          updatedAt: Date.now(),
          value: { inputItems: [], model: 'gemini-3-flash' },
        },
      ],
    });
    fs.writeFileSync(filePath, old);
    const write = vi
      .spyOn(atomic, 'writeJsonFileAtomic')
      .mockRejectedValueOnce(new Error('Synthetic write failure'));
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const writer = new OpenAIResponsesSessionStoreImpl({ filePath });
    writer.save('resp_memory_only', {
      identity: responsesIdentityFixture,
      historyOwner: resolveResponsesHistoryOwner(),
      model: 'gemini-3-flash',
      inputItems: [],
    });
    await writer.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      `Failed to persist durable state to ${filePath}`,
      expect.any(Error),
    );
    expect(fs.readFileSync(filePath, 'utf8')).toBe(old);
    const restarted = new OpenAIResponsesSessionStoreImpl({ filePath });
    expect(restarted.getHistoryOwner('resp_memory_only')).toBeNull();
    await restarted.flush();
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).entries).toEqual([]);
  });
});
