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

function isMediaRecord(value: Record<string, unknown>): boolean {
  return (
    value.type === 'input_image' ||
    value.type === 'image_url' ||
    value.type === 'input_audio' ||
    value.type === 'audio' ||
    value.type === 'audio_url'
  );
}

function isToolRecord(value: Record<string, unknown>): boolean {
  return (
    value.type === 'function_call' ||
    value.type === 'custom_tool_call' ||
    value.type === 'function_call_output' ||
    value.type === 'custom_tool_call_output'
  );
}

function isUserMessage(value: unknown): boolean {
  if (!isRecord(value) || value.role !== 'user') {
    return false;
  }
  return typeof value.type !== 'string' || value.type === 'message';
}

function boundHistoryValue(value: unknown, preserveMedia = false): BoundedValue {
  if (
    typeof value === 'string' &&
    !preserveMedia &&
    (value.startsWith('data:image/') || value.startsWith('data:audio/'))
  ) {
    return OMIT_MEDIA_VALUE;
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const bounded = boundHistoryValue(entry, preserveMedia);
      return bounded === OMIT_MEDIA_VALUE ? [] : [bounded];
    });
  }
  if (!isRecord(value)) {
    return value;
  }

  if (isMediaRecord(value)) {
    // Keep protocol media blocks intact. The request admission layer already
    // applies the hard image limits; replacing these blocks here made a
    // stored Responses continuation impossible to resume with its original
    // media.
    return cloneResponsesValue(value);
  }

  const preserveNestedMedia = preserveMedia || isToolRecord(value);
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const bounded = boundHistoryValue(entry, preserveNestedMedia);
      return bounded === OMIT_MEDIA_VALUE ? [] : [[key, bounded]];
    }),
  );
}

/**
 * Returns a caller-independent request copy with inline media removed only from
 * turns preceding the latest user message. The current turn stays intact for
 * upstream conversion and limit validation.
 */
export function omitMediaBeforeLatestUserTurn(items: unknown[]): unknown[] {
  // Historical media is part of the conversation contract by default. A
  // caller may still apply an explicit bounded window later, but the gateway
  // must not silently discard prior images merely because a new user turn was
  // appended.
  return items.map(cloneResponsesValue);
}

/** The latest user request and its following tool round form one protected operation. */
export function resolveResponsesMediaTurn(items: unknown[]): {
  items: unknown[];
  hasUserMessage: boolean;
} {
  const index = items.findLastIndex(isUserMessage);
  return { items: index < 0 ? items : items.slice(index), hasUserMessage: index >= 0 };
}

/** Removes raw inline media from durable Responses history while retaining a small marker. */
export function boundResponsesInputItems(items: unknown[]): unknown[] {
  return items.flatMap((item) => {
    const bounded = boundHistoryValue(item);
    return bounded === OMIT_MEDIA_VALUE || bounded === null ? [] : [bounded];
  });
}

/** Validates every current inline Responses image, including images nested in tool outputs. */
export function validateResponsesInputImageLimits(
  input: unknown,
  mode: 'aggregate' | 'per-image' = 'aggregate',
): void {
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

    if (value.type === 'function_call' || value.type === 'custom_tool_call') {
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
      const parsed = parseInputImageDataUrl(
        imageUrl,
        mode === 'per-image' ? 1 : imageCount,
        mode === 'per-image' ? 0 : totalBytes,
      );
      totalBytes += parsed.decodedBytes;
      return;
    }

    if (value.type === 'function_call_output' || value.type === 'custom_tool_call_output') {
      visit(value.output);
    } else if (value.type === 'message' || typeof value.role === 'string') {
      visit(value.content);
    }
  };

  visit(input);
}
