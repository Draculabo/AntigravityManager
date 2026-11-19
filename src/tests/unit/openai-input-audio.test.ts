import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { buildAntigravityGenerationRequest } from '@/modules/proxy-gateway/antigravity/AntigravityRequestBuilder';
import { toOpenAIGenerationInput } from '@/server/gateway/modules/openai/chat/openai-claude-conversion';
import {
  OPENAI_INPUT_AUDIO_BYTES_LIMIT,
  parseOpenAIInputAudio,
} from '@/server/gateway/modules/openai/chat/openai-input-audio';
import { buildResponsesChatRequest } from '@/server/gateway/modules/openai/responses/openai-responses-request';
import type { OpenAIContentPart } from '@/server/gateway/common/interfaces/request-interfaces';

function audioPart(data: string, format = 'wav'): OpenAIContentPart {
  return { type: 'input_audio', input_audio: { data, format } };
}

const UNSNIFFED_AUDIO_BYTES = Buffer.from([0x00, 0xff, 0x01, 0xfe]).toString('base64');

describe('OpenAI input_audio', () => {
  it('maps strict base64 audio to Gemini inlineData without mutating the payload', () => {
    const bytes = Buffer.from('RIFF0000WAVEfmt ', 'latin1');
    const data = bytes.toString('base64');
    const request = {
      model: 'gemini-3-flash',
      messages: [{ role: 'user', content: [audioPart(data)] }],
    };

    const input = toOpenAIGenerationInput(request);
    const gemini = buildAntigravityGenerationRequest(input, {
      projectId: 'project',
      userAgent: 'agent',
    });

    expect(gemini.request.contents[0]?.parts).toContainEqual({
      inlineData: { mimeType: 'audio/wav', data },
    });
    expect(request.messages[0]?.content[0]?.input_audio?.data).toBe(data);
  });

  it.each(['https://example.com/audio.wav', 'file:///tmp/audio.wav', 'C:\\tmp\\audio.wav'])(
    'rejects URL and filesystem input %s',
    (data) => {
      expect(() => parseOpenAIInputAudio(audioPart(data))).toThrow(BadRequestException);
    },
  );

  it('rejects non-canonical base64 instead of silently decoding it', () => {
    expect(() => parseOpenAIInputAudio(audioPart('not base64'))).toThrow(/strict base64/);
  });

  it.each([
    ['audio/mpeg', 'audio/mpeg'],
    ['m4a', 'audio/mp4'],
    ['x-wav', 'audio/wav'],
    ['opus', 'audio/ogg'],
    ['aif', 'audio/aiff'],
  ])('normalizes the declared %s format to %s', (format, expectedMimeType) => {
    expect(parseOpenAIInputAudio(audioPart(UNSNIFFED_AUDIO_BYTES, format))).toEqual({
      data: UNSNIFFED_AUDIO_BYTES,
      mimeType: expectedMimeType,
    });
  });

  it('accepts the audio type alias with the official input_audio envelope', () => {
    expect(
      parseOpenAIInputAudio({
        type: 'audio',
        input_audio: { data: UNSNIFFED_AUDIO_BYTES, format: 'mp3' },
      }),
    ).toEqual({ data: UNSNIFFED_AUDIO_BYTES, mimeType: 'audio/mpeg' });
  });

  it('uses and validates the MIME type declared by a data URL', () => {
    expect(
      parseOpenAIInputAudio(audioPart(`data:audio/x-wav;base64,${UNSNIFFED_AUDIO_BYTES}`)),
    ).toEqual({
      data: UNSNIFFED_AUDIO_BYTES,
      mimeType: 'audio/wav',
    });
    expect(() =>
      parseOpenAIInputAudio(audioPart(`data:audio/unknown;base64,${UNSNIFFED_AUDIO_BYTES}`)),
    ).toThrow(/format must identify/);
  });

  it('preserves input_audio while normalizing a Responses request', () => {
    const request = buildResponsesChatRequest({
      model: 'gemini-3-flash',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: { data: UNSNIFFED_AUDIO_BYTES, format: 'm4a' },
            },
          ],
        },
      ],
    });

    expect(request.messages[0]?.content).toEqual([
      {
        type: 'input_audio',
        input_audio: { data: UNSNIFFED_AUDIO_BYTES, format: 'm4a' },
      },
    ]);
  });

  it('rejects a non-string audio format in an untrusted Responses payload', () => {
    expect(() =>
      buildResponsesChatRequest({
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_audio',
                input_audio: { data: UNSNIFFED_AUDIO_BYTES, format: false },
              },
            ],
          },
        ],
      }),
    ).toThrow(/input_audio must be an object with string data and optional string format/);
  });

  it('rejects decoded audio larger than 15 MiB', () => {
    const data = Buffer.alloc(OPENAI_INPUT_AUDIO_BYTES_LIMIT + 1, 1).toString('base64');
    expect(() => parseOpenAIInputAudio(audioPart(data, 'aac'))).toThrow(/exceeds/);
  });

  it.each([
    ['PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['PDF', Buffer.from('%PDF-1.7', 'latin1')],
  ])('rejects positively identified %s bytes disguised as MP3', (_label, bytes) => {
    expect(() => parseOpenAIInputAudio(audioPart(bytes.toString('base64'), 'mp3'))).toThrow(
      /not audio/,
    );
  });

  it('accepts an MP4 container only when its brand identifies M4A audio', () => {
    const m4a = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from('ftypM4A ', 'latin1'),
      Buffer.alloc(12),
    ]);
    const genericMp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from('ftypisom', 'latin1'),
      Buffer.alloc(12),
    ]);

    expect(parseOpenAIInputAudio(audioPart(m4a.toString('base64'), 'm4a'))).toEqual({
      data: m4a.toString('base64'),
      mimeType: 'audio/mp4',
    });
    expect(() => parseOpenAIInputAudio(audioPart(genericMp4.toString('base64'), 'm4a'))).toThrow(
      /not audio/,
    );
  });
});
