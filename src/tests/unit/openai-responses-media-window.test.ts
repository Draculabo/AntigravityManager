import { describe, expect, it } from 'vitest';

import {
  applyResponsesImageSendWindow,
  ResponsesMediaWindowLimitError,
} from '@/server/gateway/modules/openai/responses/openai-responses-media-window';

const image = (data: string, id?: string) => ({
  ...(id ? { id } : {}),
  type: 'message',
  role: 'user',
  content: [{ type: 'input_image', image_url: `data:image/png;base64,${data}` }],
});

describe('Responses image send window', () => {
  it('protects tool-only results around calls repaired from the session cache', () => {
    const first = { type: 'function_call_output', call_id: 'a', output: image('AQ==').content };
    const second = { type: 'function_call_output', call_id: 'b', output: image('Ag==').content };
    const result = applyResponsesImageSendWindow(
      [
        image('Aw=='),
        { type: 'function_call', call_id: 'a', name: 'capture' },
        first,
        { type: 'function_call', call_id: 'b', name: 'capture' },
        second,
      ],
      {
        per_account_concurrency: 4,
        send_window_enabled: true,
        send_window_strategy: 'count',
        send_window_count: 1,
        send_window_memory_mib: 1,
        send_window_strip_remote_urls: false,
      },
      [first, second],
    );
    expect(result[1]).toEqual({ type: 'function_call', call_id: 'a', name: 'capture' });
    expect(result[2]).toEqual(first);
    expect(result[3]).toEqual({ type: 'function_call', call_id: 'b', name: 'capture' });
    expect(result[4]).toEqual(second);
    expect(result[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: expect.stringContaining('image omitted') }],
    });
  });

  it('protects a tool result whose missing ID was assigned during association admission', () => {
    const original = {
      type: 'function_call_output',
      output: image(Buffer.alloc(2 * 1024 * 1024).toString('base64')).content,
    };
    const admitted = { ...original, call_id: 'assigned' };
    expect(() =>
      applyResponsesImageSendWindow(
        [admitted],
        {
          per_account_concurrency: 4,
          send_window_enabled: true,
          send_window_strategy: 'memory',
          send_window_count: 1,
          send_window_memory_mib: 1,
          send_window_strip_remote_urls: false,
        },
        [original],
      ),
    ).toThrow(ResponsesMediaWindowLimitError);
  });

  it('protects only the current occurrence of an identical repeated image', () => {
    const old = image('AQ==');
    const current = structuredClone(old);
    const input = [old, current];
    const before = structuredClone(input);
    const result = applyResponsesImageSendWindow(
      input,
      {
        per_account_concurrency: 4,
        send_window_enabled: true,
        send_window_strategy: 'count',
        send_window_count: 1,
        send_window_memory_mib: 1,
        send_window_strip_remote_urls: false,
      },
      [structuredClone(current)],
    );
    expect(result[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: expect.stringContaining('image omitted') }],
    });
    expect(result[1]).toEqual(current);
    expect(input).toEqual(before);
  });

  it('windows the supported object URL form without rewriting its original', () => {
    const old = {
      role: 'user',
      content: [
        { type: 'input_image', image_url: { url: 'data:image/png;base64,AQ==', detail: 'high' } },
      ],
    };
    const current = image('Ag==');
    const result = applyResponsesImageSendWindow(
      [old, current],
      {
        per_account_concurrency: 4,
        send_window_enabled: true,
        send_window_strategy: 'count',
        send_window_count: 1,
        send_window_memory_mib: 1,
        send_window_strip_remote_urls: false,
      },
      [current],
    );
    expect(result[0]).toEqual({
      role: 'user',
      content: [{ type: 'input_text', text: expect.stringContaining('image omitted') }],
    });
    expect(old.content[0].image_url.url).toBe('data:image/png;base64,AQ==');
    expect(result[1]).toEqual(current);
  });

  it('never traverses tool arguments or message metadata as media slots', () => {
    const call = {
      type: 'function_call',
      name: 'inspect',
      arguments: { type: 'input_image', image_url: 'data:image/png;base64,AQ==' },
    };
    const historical = {
      ...image('Ag=='),
      metadata: { example: { type: 'input_image', image_url: 'data:image/png;base64,Aw==' } },
    };
    const current = image('BA==');
    const result = applyResponsesImageSendWindow(
      [call, historical, current],
      {
        per_account_concurrency: 4,
        send_window_enabled: true,
        send_window_strategy: 'count',
        send_window_count: 1,
        send_window_memory_mib: 1,
        send_window_strip_remote_urls: false,
      },
      [current],
    );
    expect(result[0]).toEqual(call);
    expect(result[1]).toMatchObject({ metadata: historical.metadata });
    expect(result[2]).toEqual(current);
  });

  it('keeps the existing behavior when the window is disabled', () => {
    const input = [image('AQ=='), image('Ag==')];
    expect(
      applyResponsesImageSendWindow(input, {
        per_account_concurrency: 4,
        send_window_enabled: false,
        send_window_strategy: 'count',
        send_window_count: 1,
        send_window_memory_mib: 1,
        send_window_strip_remote_urls: true,
      }),
    ).toEqual(input);
  });

  it('keeps the newest historical image and protects every current image', () => {
    const oldA = image('AQ==', 'old-a');
    const oldB = image('Ag==', 'old-b');
    const current = image('Aw==', 'current');
    const result = applyResponsesImageSendWindow(
      [oldA, oldB, current],
      {
        per_account_concurrency: 4,
        send_window_enabled: true,
        send_window_strategy: 'count',
        send_window_count: 2,
        send_window_memory_mib: 1,
        send_window_strip_remote_urls: false,
      },
      [current],
    );

    expect(result[0]).toEqual({
      id: 'old-a',
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: expect.stringContaining('image omitted') }],
    });
    expect(result[1]).toEqual(oldB);
    expect(result[2]).toEqual(current);
  });

  it('protects current items without requiring client supplied item ids', () => {
    const old = image('AQ==');
    const current = image('Ag==');
    const result = applyResponsesImageSendWindow(
      [old, current],
      {
        per_account_concurrency: 4,
        send_window_enabled: true,
        send_window_strategy: 'count',
        send_window_count: 0,
        send_window_memory_mib: 1,
        send_window_strip_remote_urls: false,
      },
      [structuredClone(current)],
    );
    expect(result[1]).toEqual(current);
  });

  it('uses exact decoded bytes including Base64 padding for memory budgeting', () => {
    const current = image('AQ==', 'current');
    expect(() =>
      applyResponsesImageSendWindow(
        [current],
        {
          per_account_concurrency: 4,
          send_window_enabled: true,
          send_window_strategy: 'memory',
          send_window_count: 10,
          send_window_memory_mib: 1,
          send_window_strip_remote_urls: false,
        },
        [current],
      ),
    ).not.toThrow();
  });

  it('reports when the protected current turn exceeds the configured memory budget', () => {
    const current = image('AQ==', 'current');
    expect(() =>
      applyResponsesImageSendWindow(
        [current],
        {
          per_account_concurrency: 4,
          send_window_enabled: true,
          send_window_strategy: 'memory',
          send_window_count: 10,
          send_window_memory_mib: 0,
          send_window_strip_remote_urls: false,
        } as never,
        [current],
      ),
    ).toThrow(ResponsesMediaWindowLimitError);
  });

  it('retains remote images unless explicit remote stripping is enabled', () => {
    const remote = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: 'https://example.invalid/image.png' }],
    };
    const result = applyResponsesImageSendWindow([remote], {
      per_account_concurrency: 4,
      send_window_enabled: true,
      send_window_strategy: 'count',
      send_window_count: 0,
      send_window_memory_mib: 1,
      send_window_strip_remote_urls: false,
    });
    expect(result).toEqual([remote]);
  });
});
