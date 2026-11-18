import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type {
  OpenAIChatRequest,
  OpenAIContentPart,
} from '../../../common/interfaces/request-interfaces';
import { sniffMimeType } from '../../files/file-mime-sniff';

export const OPENAI_INPUT_AUDIO_BYTES_LIMIT = 15 * 1024 * 1024;

const AUDIO_FORMAT_MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  mpeg: 'audio/mpeg',
  mpga: 'audio/mpeg',
  wav: 'audio/wav',
  wave: 'audio/wav',
  'x-wav': 'audio/wav',
  'vnd.wave': 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  'x-flac': 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  'x-m4a': 'audio/mp4',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  'x-aiff': 'audio/aiff',
};
const SUPPORTED_AUDIO_MIME_TYPES = new Set(Object.values(AUDIO_FORMAT_MIME_TYPES));
const BASE64_CHARACTER_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;
const OpenAIInputAudioEnvelopeSchema = z.object({
  data: z.string(),
  format: z.string().optional(),
});

export interface ParsedOpenAIInputAudio {
  data: string;
  mimeType: string;
}

function invalid(message: string): never {
  throw new BadRequestException(`Invalid input_audio: ${message}`);
}

export function isM4aContainer(bytes: Buffer): boolean {
  if (bytes.length < 12 || bytes.subarray(4, 8).toString('latin1') !== 'ftyp') {
    return false;
  }

  const audioBrands = new Set(['M4A ', 'M4B ', 'M4P ', 'M4R ']);
  const brandLimit = Math.min(bytes.length, 64);
  for (let offset = 8; offset + 4 <= brandLimit; offset += 4) {
    if (audioBrands.has(bytes.subarray(offset, offset + 4).toString('latin1'))) {
      return true;
    }
  }
  return false;
}

export function parseOpenAIInputAudio(part: OpenAIContentPart): ParsedOpenAIInputAudio {
  if (part.type !== 'input_audio' && part.type !== 'audio') {
    return invalid('unsupported content type');
  }
  const parsedInput = OpenAIInputAudioEnvelopeSchema.safeParse(part.input_audio);
  if (!parsedInput.success) {
    return invalid('input_audio must be an object with string data and optional string format');
  }

  const input = parsedInput.data;
  if (input.data.trim() === '') {
    return invalid('data must be a non-empty base64 string or data URL');
  }

  const raw = input.data.trim();
  if (/^(?:https?:|file:)/iu.test(raw) || /^[A-Za-z]:[\\/]/u.test(raw) || raw.startsWith('/')) {
    return invalid('remote URLs and local filesystem paths are not supported');
  }

  const dataUrl = /^data:(?<mime>[^;,]+);base64,(?<data>[\s\S]*)$/iu.exec(raw);
  const dataUrlFormat = dataUrl?.groups?.mime
    ?.trim()
    .toLowerCase()
    .replace(/^audio\//u, '');
  const format =
    input.format
      ?.trim()
      .toLowerCase()
      .replace(/^audio\//u, '') ?? 'mp3';
  const declaredFromDataUrl = dataUrlFormat ? AUDIO_FORMAT_MIME_TYPES[dataUrlFormat] : undefined;
  const declaredFromFormat = AUDIO_FORMAT_MIME_TYPES[format];
  const declaredMimeType = dataUrl ? declaredFromDataUrl : declaredFromFormat;
  const base64 = dataUrl?.groups?.data ?? raw;
  if (!base64 || base64.length % 4 !== 0 || !BASE64_CHARACTER_PATTERN.test(base64)) {
    return invalid('data is not strict base64');
  }

  const paddingBytes = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const decodedSize = (base64.length / 4) * 3 - paddingBytes;
  if (decodedSize > OPENAI_INPUT_AUDIO_BYTES_LIMIT) {
    return invalid(`decoded audio exceeds ${OPENAI_INPUT_AUDIO_BYTES_LIMIT} bytes`);
  }

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) {
    return invalid('decoded audio is empty');
  }
  if (bytes.toString('base64') !== base64) {
    return invalid('data is not canonical base64');
  }

  const sniffed = sniffMimeType(bytes);
  let mimeType = declaredMimeType;
  if (sniffed?.startsWith('audio/')) {
    mimeType = sniffed;
  } else if (sniffed === 'video/mp4' && declaredMimeType === 'audio/mp4' && isM4aContainer(bytes)) {
    mimeType = 'audio/mp4';
  } else if (sniffed) {
    return invalid(`decoded bytes identify ${sniffed}, not audio`);
  }
  if (!mimeType || !SUPPORTED_AUDIO_MIME_TYPES.has(mimeType)) {
    return invalid('format must identify mp3, wav, ogg, flac, aac/m4a, or aiff audio');
  }
  return { data: base64, mimeType };
}

export function validateOpenAIInputAudio(request: OpenAIChatRequest): void {
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'input_audio' || part.type === 'audio') {
        parseOpenAIInputAudio(part);
      }
    }
  }
}
