import { describe, expect, it } from 'vitest';

import {
  applyResponsesImageSendWindow,
  ResponsesMediaWindowLimitError,
} from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-media-window';

const image = (data: string, id?: string) => ({
  ...(id ? { id } : {}),
  type: 'message',
  role: 'user',
  content: [{ type: 'input_image', image_url: `data:image/png;base64,${data}` }],
});

describe('Responses image send window', () => {
  it('keeps the existing behavior when the window is disabled', () => {
    const input = [image('AQ=='), image('Ag==')];
    expect(
      applyResponsesImageSendWindow(input, {
        per_account_concurrency: 4,
        send_window_enabled: false,
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
        send_window_count: 1,
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
      send_window_count: 0,
      send_window_memory_mib: 1,
      send_window_strip_remote_urls: false,
    });
    expect(result).toEqual([remote]);
  });
});
