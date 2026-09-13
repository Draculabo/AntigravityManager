import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { convertOpenAIToClaude } from '@/modules/proxy-gateway/server/modules/openai/chat/openai-claude-conversion';
import {
  normalizeVideoMime,
  resolveOpenAIVideoUrl,
} from '@/modules/proxy-gateway/server/modules/openai/chat/openai-video-url';
import type { OpenAIContentPart } from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import { logger } from '@/shared/logging/logger';

vi.mock('@/shared/logging/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

function videoPart(url: string, mimeType?: string): OpenAIContentPart {
  return {
    type: 'video_url',
    video_url: { url, ...(mimeType ? { mime_type: mimeType } : {}) },
  };
}

function mapVideoToGemini(url: string, allowLocalVideoPaths = false) {
  const claude = convertOpenAIToClaude(
    {
      model: 'gemini-3-flash',
      messages: [{ role: 'user', content: [videoPart(url)] }],
    },
    undefined,
    { allowLocalVideoPaths },
  );
  return transformClaudeRequestIn(claude, 'project', 'agent', undefined, 'openai').request
    .contents[0]?.parts;
}

describe('OpenAI video_url conversion', () => {
  let tempDirectory: string;
  let videoPath: string;
  const videoBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03]);

  beforeEach(() => {
    vi.clearAllMocks();
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-video-url-'));
    videoPath = path.join(tempDirectory, 'sample.webm');
    fs.writeFileSync(videoPath, videoBytes);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it('maps data URLs, remote URLs and raw base64 in compatibility order', () => {
    expect(mapVideoToGemini('data:video/mp4;base64,AAAA')).toEqual([
      { inlineData: { mimeType: 'video/mp4', data: 'AAAA' } },
    ]);
    expect(mapVideoToGemini('https://example.com/demo.webm?download=1')).toEqual([
      {
        fileData: {
          mimeType: 'video/webm',
          fileUri: 'https://example.com/demo.webm?download=1',
        },
      },
    ]);
    expect(mapVideoToGemini('http://example.com/demo.mov')).toEqual([
      {
        fileData: {
          mimeType: 'video/quicktime',
          fileUri: 'http://example.com/demo.mov',
        },
      },
    ]);
    expect(resolveOpenAIVideoUrl(videoPart('AQID', 'mkv').video_url)).toEqual({
      type: 'base64',
      media_type: 'video/x-matroska',
      data: 'AQID',
    });
  });

  it.each([
    ['ordinary path', () => videoPath],
    ['file URL', () => pathToFileURL(videoPath).href],
  ])('reads a local video from an enabled %s', (_label, source) => {
    expect(mapVideoToGemini(source(), true)).toEqual([
      {
        inlineData: {
          mimeType: 'video/webm',
          data: videoBytes.toString('base64'),
        },
      },
    ]);
  });

  it('does not read a directory or special target through an enabled file URL', () => {
    const readSpy = vi.spyOn(fs, 'readFileSync');

    expect(
      resolveOpenAIVideoUrl(videoPart(pathToFileURL(tempDirectory).href).video_url, {
        allowLocalPaths: true,
      }),
    ).toBeNull();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('does not touch the filesystem for explicit local paths while the opt-in is disabled', () => {
    const statSpy = vi.spyOn(fs, 'statSync');
    const readSpy = vi.spyOn(fs, 'readFileSync');

    expect(resolveOpenAIVideoUrl(videoPart(videoPath).video_url)).toBeNull();
    expect(resolveOpenAIVideoUrl(videoPart(pathToFileURL(videoPath).href).video_url)).toBeNull();
    expect(resolveOpenAIVideoUrl(videoPart('./sample.webm').video_url)).toBeNull();
    expect(resolveOpenAIVideoUrl(videoPart('AQID').video_url)).toEqual({
      type: 'base64',
      media_type: 'video/mp4',
      data: 'AQID',
    });
    expect(statSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    expect(mapVideoToGemini(videoPath)).toEqual([{ text: 'Continue' }]);
  });

  it('keeps the tool-result fallback when a local path is disabled', () => {
    const request = convertOpenAIToClaude({
      model: 'gemini-3-flash',
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_video',
          content: [videoPart(videoPath)],
        },
      ],
    });

    expect(request.messages[0]?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'call_video',
        content: '[video]',
        is_error: false,
      },
    ]);
  });

  it('emits successful tool video after the function response', () => {
    const request = convertOpenAIToClaude(
      {
        model: 'gemini-3-flash',
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_video',
                type: 'function',
                function: { name: 'inspect_video', arguments: '{}' },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'call_video',
            content: [videoPart(videoPath)],
          },
        ],
      },
      undefined,
      { allowLocalVideoPaths: true },
    );

    const contents = transformClaudeRequestIn(request, 'project', 'agent', undefined, 'openai')
      .request.contents;
    expect(contents[2]?.parts).toEqual([
      {
        functionResponse: {
          name: 'inspect_video',
          response: { result: '' },
          id: 'call_video',
        },
      },
      {
        inlineData: {
          mimeType: 'video/webm',
          data: videoBytes.toString('base64'),
        },
      },
    ]);
  });

  it.each(['mime_type', 'mimeType', 'format'] as const)(
    'accepts %s as a declared MIME alias',
    (field) => {
      expect(
        resolveOpenAIVideoUrl({ url: 'AQID', [field]: 'webm' } as NonNullable<
          OpenAIContentPart['video_url']
        >),
      ).toEqual({
        type: 'base64',
        media_type: 'video/webm',
        data: 'AQID',
      });
    },
  );

  it.each([
    ['mp4', 'video/mp4'],
    ['m4v', 'video/mp4'],
    ['webm', 'video/webm'],
    ['mov', 'video/quicktime'],
    ['quicktime', 'video/quicktime'],
    ['avi', 'video/x-msvideo'],
    ['x-msvideo', 'video/x-msvideo'],
    ['wmv', 'video/x-ms-wmv'],
    ['x-ms-wmv', 'video/x-ms-wmv'],
    ['flv', 'video/x-flv'],
    ['x-flv', 'video/x-flv'],
    ['mkv', 'video/x-matroska'],
    ['x-matroska', 'video/x-matroska'],
    ['3gp', 'video/3gpp'],
    ['3gpp', 'video/3gpp'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeVideoMime(input)).toBe(expected);
  });

  it('falls back unknown path extensions to video/mp4 but preserves explicit formats', () => {
    const unknownPath = path.join(tempDirectory, 'sample.custom-video');
    fs.writeFileSync(unknownPath, videoBytes);

    expect(resolveOpenAIVideoUrl({ url: unknownPath }, { allowLocalPaths: true })).toMatchObject({
      type: 'base64',
      media_type: 'video/mp4',
    });
    expect(normalizeVideoMime('CUSTOM-VIDEO')).toBe('video/custom-video');
  });

  it('warns but still returns local and raw inline videos above 20 MiB', () => {
    const oversizedBytes = Buffer.alloc(20 * 1024 * 1024 + 1, 0x01);
    const oversizedPath = path.join(tempDirectory, 'oversized.mp4');
    fs.writeFileSync(oversizedPath, oversizedBytes);

    const local = resolveOpenAIVideoUrl({ url: oversizedPath }, { allowLocalPaths: true });
    expect(local?.type).toBe('base64');
    expect(logger.warn).toHaveBeenCalledTimes(1);

    const oversizedBase64 = 'A'.repeat(Math.ceil((20 * 1024 * 1024 + 1) * (4 / 3)));
    const raw = resolveOpenAIVideoUrl({ url: oversizedBase64, format: 'mp4' });
    expect(raw?.type).toBe('base64');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
