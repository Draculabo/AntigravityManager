import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  mergeOpenAIResponsesInputItems,
  OpenAIResponsesSessionStore,
} from '@/modules/proxy-gateway/server/openai-responses-session.store';

describe('OpenAIResponsesSessionStore', () => {
  afterEach(() => {
    OpenAIResponsesSessionStore.clear();
    vi.useRealTimers();
  });

  it('expires continuation history after one hour', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:00.000Z'));
    OpenAIResponsesSessionStore.save('resp_expiring', {
      inputItems: [{ type: 'message', role: 'user' }],
      model: 'gpt-4o',
    });

    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(OpenAIResponsesSessionStore.get('resp_expiring')).toBeNull();
  });

  it('removes local commentary transcripts while retaining final answers and tool calls', () => {
    const merged = mergeOpenAIResponsesInputItems(
      [
        {
          content: [{ text: 'Inspecting files', type: 'output_text' }],
          id: 'msg_thought_resp_1',
          phase: 'commentary',
          role: 'assistant',
          type: 'message',
        },
        {
          content: [{ text: 'Final result', type: 'output_text' }],
          id: 'msg_final_resp_1',
          phase: 'final_answer',
          role: 'assistant',
          type: 'message',
        },
        {
          arguments: '{}',
          call_id: 'call_1',
          id: 'item_call_1',
          name: 'search_docs',
          type: 'function_call',
        },
      ],
      [{ content: 'Continue', role: 'user', type: 'message' }],
    );

    expect(merged).toEqual([
      expect.objectContaining({ id: 'msg_final_resp_1' }),
      expect.objectContaining({ call_id: 'call_1' }),
      expect.objectContaining({ role: 'user' }),
    ]);
  });

  it('removes legacy visible thinking transcripts by their text prefix', () => {
    expect(
      mergeOpenAIResponsesInputItems(
        [
          {
            content: [{ text: '**Thinking**\nInspecting files', type: 'output_text' }],
            id: 'legacy_reasoning',
            role: 'assistant',
            type: 'message',
          },
        ],
        [],
      ),
    ).toEqual([]);
  });
});
