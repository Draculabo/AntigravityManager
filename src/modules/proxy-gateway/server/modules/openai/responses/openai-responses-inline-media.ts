import { parseInputImageDataUrl } from '../media/image-input-validation';

const OMIT_MEDIA_VALUE = Symbol('omit-responses-media-value');

type BoundedValue = unknown | typeof OMIT_MEDIA_VALUE;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneResponsesValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneResponsesValue);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneResponsesValue(entry)]),
  );
}

function mediaPlaceholder(value: Record<string, unknown>): Record<string, string> | null {
  if (value.type === 'input_image' || value.type === 'image_url') {
    return { type: 'input_text', text: '[historical image omitted]' };
  }
  if (value.type === 'input_audio' || value.type === 'audio' || value.type === 'audio_url') {
    return { type: 'input_text', text: '[historical audio omitted]' };
  }
  return null;
}

function boundHistoryValue(value: unknown): BoundedValue {
  if (
    typeof value === 'string' &&
    (value.startsWith('data:image/') || value.startsWith('data:audio/'))
  ) {
    return OMIT_MEDIA_VALUE;
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const bounded = boundHistoryValue(entry);
      return bounded === OMIT_MEDIA_VALUE ? [] : [bounded];
    });
  }
  if (!isRecord(value)) {
    return value;
  }

  const placeholder = mediaPlaceholder(value);
  if (placeholder) {
    return placeholder;
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const bounded = boundHistoryValue(entry);
      return bounded === OMIT_MEDIA_VALUE ? [] : [[key, bounded]];
    }),
  );
}

function isUserMessage(value: unknown): boolean {
  if (!isRecord(value) || value.role !== 'user') {
    return false;
  }
  return typeof value.type !== 'string' || value.type === 'message';
}

/**
 * Returns a caller-independent request copy with inline media removed only from
 * turns preceding the latest user message. The current turn stays intact for
 * upstream conversion and limit validation.
 */
export function omitMediaBeforeLatestUserTurn(items: unknown[]): unknown[] {
  const cloned = items.map(cloneResponsesValue);
  const currentTurnStart = cloned.findLastIndex(isUserMessage);
  if (currentTurnStart < 0) {
    return cloned;
  }

  for (let index = 0; index < currentTurnStart; index += 1) {
    const bounded = boundHistoryValue(cloned[index]);
    cloned[index] = bounded === OMIT_MEDIA_VALUE ? null : bounded;
  }
  return cloned;
}

/** Removes raw inline media from durable Responses history while retaining a small marker. */
export function boundResponsesInputItems(items: unknown[]): unknown[] {
  return items.flatMap((item) => {
    const bounded = boundHistoryValue(item);
    return bounded === OMIT_MEDIA_VALUE || bounded === null ? [] : [bounded];
  });
}

/** Validates every current inline Responses image, including images nested in tool outputs. */
export function validateResponsesInputImageLimits(input: unknown): void {
  let imageCount = 0;
  let totalBytes = 0;

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }

    if (value.type === 'input_image' || value.type === 'image_url') {
      const rawImageUrl = value.image_url;
      const imageUrl =
        typeof rawImageUrl === 'string'
          ? rawImageUrl
          : isRecord(rawImageUrl) && typeof rawImageUrl.url === 'string'
            ? rawImageUrl.url
            : null;
      if (!imageUrl?.startsWith('data:')) {
        return;
      }

      imageCount += 1;
      const parsed = parseInputImageDataUrl(imageUrl, imageCount, totalBytes);
      totalBytes += parsed.decodedBytes;
      return;
    }

    for (const entry of Object.values(value)) {
      visit(entry);
    }
  };

  visit(input);
}
