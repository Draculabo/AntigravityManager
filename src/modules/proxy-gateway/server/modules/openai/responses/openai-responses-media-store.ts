import { GoneException } from '@nestjs/common';

import type { PrivateContentStore } from '../../files/files.service';

const MEDIA_REFERENCE_FIELD = '__agm_responses_media_reference';
const MEDIA_REFERENCE_VERSION = 1;
const MEDIA_ID_PATTERN = /^[a-f0-9]{32}$/u;
const DATA_URL_MIME_PATTERN = /^data:((?:image|audio)\/[a-z0-9.+_-]+)(?:;[^,]*)*;base64$/iu;
const BASE64_PATTERN = /^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/iu;

interface ResponsesMediaReference {
  [MEDIA_REFERENCE_FIELD]: typeof MEDIA_REFERENCE_VERSION;
  encoding: 'base64' | 'data-url';
  id: string;
  prefix?: string;
}

export class ResponsesMediaUnavailableError extends GoneException {
  public constructor() {
    super(
      'Stored Responses media has expired or is missing. Start a new conversation or resend the original media.',
    );
    this.name = 'ResponsesMediaUnavailableError';
  }
}

/**
 * Keeps protocol media out of durable Responses JSON while preserving the
 * original bytes in a private, bounded content namespace.
 */
export class OpenAIResponsesMediaStore {
  public constructor(private readonly content: PrivateContentStore) {}

  public dispose(): void {
    this.content.dispose();
  }

  public async externalize(items: unknown[]): Promise<unknown[]> {
    return (await transformResponsesMedia(items, async (value, representation) => {
      if (isMediaReference(value)) {
        throw new Error('Client supplied an internal Responses media reference');
      }

      if (representation === 'data-url') {
        if (typeof value !== 'string' || !value.startsWith('data:')) {
          return value;
        }
        return this.storeDataUrl(value);
      }

      if (typeof value !== 'string') {
        return value;
      }
      return this.storeBase64(value);
    })) as unknown[];
  }

  public async restore(items: unknown[]): Promise<unknown[]> {
    return (await transformResponsesMedia(items, async (value) => {
      if (!isMediaReference(value)) {
        return value;
      }
      if (!isValidMediaReference(value)) {
        throw new ResponsesMediaUnavailableError();
      }

      let bytes: Buffer;
      try {
        bytes = await this.content.get(value.id);
      } catch {
        throw new ResponsesMediaUnavailableError();
      }
      const encoded = bytes.toString('base64');
      return value.encoding === 'data-url' ? `data:${value.prefix}${encoded}` : encoded;
    })) as unknown[];
  }

  private async storeBase64(value: string): Promise<ResponsesMediaReference> {
    const bytes = decodeBase64(value);
    const id = await this.content.put(bytes);
    return {
      [MEDIA_REFERENCE_FIELD]: MEDIA_REFERENCE_VERSION,
      encoding: 'base64',
      id,
    };
  }

  private async storeDataUrl(value: string): Promise<ResponsesMediaReference> {
    const separator = value.indexOf(',');
    if (separator < 0) {
      throw new Error('Invalid inline Responses media data URL');
    }
    const prefix = value.slice('data:'.length, separator + 1);
    const header = value.slice(0, separator);
    const mimeType = DATA_URL_MIME_PATTERN.exec(header)?.[1];
    if (!mimeType) {
      throw new Error('Invalid inline Responses media data URL');
    }
    const bytes = decodeBase64(value.slice(separator + 1));
    const id = await this.content.put(bytes, mimeType);
    return {
      [MEDIA_REFERENCE_FIELD]: MEDIA_REFERENCE_VERSION,
      encoding: 'data-url',
      id,
      prefix,
    };
  }
}

/** Used by the session codec to discard old unreferenced inline-media records. */
export function containsInlineResponsesMedia(value: unknown): boolean {
  return inspectResponsesMedia(value, (mediaValue, representation) => {
    if (isMediaReference(mediaValue)) {
      return false;
    }
    if (representation === 'data-url') {
      return typeof mediaValue === 'string' && mediaValue.startsWith('data:');
    }
    return typeof mediaValue === 'string' && mediaValue.length > 0;
  });
}

/** Reject malformed references while accepting ordinary tool arguments unchanged. */
export function hasInvalidResponsesMediaReference(value: unknown): boolean {
  return inspectResponsesMedia(value, (mediaValue) => {
    return isMediaReference(mediaValue) && !isValidMediaReference(mediaValue);
  });
}

export function containsResponsesMediaReference(value: unknown): boolean {
  return inspectResponsesMedia(value, isMediaReference);
}

async function transformResponsesMedia(
  value: unknown,
  transformMedia: (mediaValue: unknown, representation: 'base64' | 'data-url') => Promise<unknown>,
): Promise<unknown> {
  if (Array.isArray(value)) {
    const mapped: unknown[] = [];
    for (const entry of value) {
      mapped.push(await transformResponsesMedia(entry, transformMedia));
    }
    return mapped;
  }
  if (!isRecord(value)) {
    return value;
  }
  if (isToolCallRecord(value)) {
    return structuredClone(value);
  }
  if (isMediaRecord(value)) {
    return transformMediaRecord(value, transformMedia);
  }

  const mapped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    mapped[key] = await transformResponsesMedia(entry, transformMedia);
  }
  return mapped;
}

async function transformMediaRecord(
  value: Record<string, unknown>,
  transformMedia: (mediaValue: unknown, representation: 'base64' | 'data-url') => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const mapped = structuredClone(value);
  if (value.type === 'input_image' || value.type === 'image_url') {
    mapped.image_url = await transformUrlValue(value.image_url, transformMedia);
    return mapped;
  }
  if (value.type === 'audio_url') {
    mapped.audio_url = await transformUrlValue(value.audio_url, transformMedia);
    return mapped;
  }

  const field = value.type === 'audio' ? 'audio' : 'input_audio';
  const audio = value[field];
  if (isRecord(audio) && (typeof audio.data === 'string' || isMediaReference(audio.data))) {
    mapped[field] = {
      ...structuredClone(audio),
      data: await transformMedia(audio.data, 'base64'),
    };
  }
  return mapped;
}

async function transformUrlValue(
  value: unknown,
  transformMedia: (mediaValue: unknown, representation: 'base64' | 'data-url') => Promise<unknown>,
): Promise<unknown> {
  if (typeof value === 'string') {
    return transformMedia(value, 'data-url');
  }
  if (isMediaReference(value)) {
    return transformMedia(value, 'data-url');
  }
  if (!isRecord(value) || typeof value.url !== 'string') {
    return value;
  }
  return {
    ...structuredClone(value),
    url: await transformMedia(value.url, 'data-url'),
  };
}

function inspectResponsesMedia(
  value: unknown,
  inspect: (mediaValue: unknown, representation: 'base64' | 'data-url') => boolean,
): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => inspectResponsesMedia(entry, inspect));
  }
  if (!isRecord(value)) {
    return false;
  }
  if (isToolCallRecord(value)) {
    return false;
  }
  if (isMediaRecord(value)) {
    if (value.type === 'input_image' || value.type === 'image_url') {
      return inspectUrlValue(value.image_url, inspect);
    }
    if (value.type === 'audio_url') {
      return inspectUrlValue(value.audio_url, inspect);
    }
    const field = value.type === 'audio' ? 'audio' : 'input_audio';
    const audio = value[field];
    return isRecord(audio) && inspect(audio.data, 'base64');
  }
  return Object.values(value).some((entry) => inspectResponsesMedia(entry, inspect));
}

function inspectUrlValue(
  value: unknown,
  inspect: (mediaValue: unknown, representation: 'base64' | 'data-url') => boolean,
): boolean {
  if (typeof value === 'string') {
    return inspect(value, 'data-url');
  }
  if (isMediaReference(value)) {
    return inspect(value, 'data-url');
  }
  return isRecord(value) && inspect(value.url, 'data-url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMediaRecord(value: Record<string, unknown>): boolean {
  return (
    value.type === 'input_image' ||
    value.type === 'image_url' ||
    value.type === 'input_audio' ||
    value.type === 'audio' ||
    value.type === 'audio_url'
  );
}

function isToolCallRecord(value: Record<string, unknown>): boolean {
  return value.type === 'function_call' || value.type === 'custom_tool_call';
}

function isMediaReference(value: unknown): value is ResponsesMediaReference {
  return isRecord(value) && MEDIA_REFERENCE_FIELD in value;
}

function isValidMediaReference(value: ResponsesMediaReference): boolean {
  if (
    value[MEDIA_REFERENCE_FIELD] !== MEDIA_REFERENCE_VERSION ||
    !MEDIA_ID_PATTERN.test(value.id)
  ) {
    return false;
  }
  if (value.encoding === 'base64') {
    return value.prefix === undefined;
  }
  return (
    value.encoding === 'data-url' &&
    typeof value.prefix === 'string' &&
    DATA_URL_MIME_PATTERN.test(`data:${value.prefix.slice(0, -1)}`)
  );
}

function decodeBase64(value: string): Buffer {
  if (!value || !BASE64_PATTERN.test(value)) {
    throw new Error('Invalid inline Responses media base64 data');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== value) {
    throw new Error('Invalid inline Responses media base64 data');
  }
  return bytes;
}
