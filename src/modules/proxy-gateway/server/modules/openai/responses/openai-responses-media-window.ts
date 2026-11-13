import type { ImageSchedulerConfig } from '@/modules/config/types';
import { isEqual } from 'lodash-es';
import {
  MEDIA_WINDOW_OMISSION_TEXT,
  MediaWindowLimitError,
  planMediaSendWindow,
  type MediaWindowCandidate,
} from '../../../common/media-send-window';

const INLINE_IMAGE_PATTERN = /^data:image\/[^;,]+;[^,]*base64,([\s\S]*)$/iu;

interface ImageCandidate {
  slot: MediaWindowCandidate;
  path: Array<string | number>;
}

export { MediaWindowLimitError as ResponsesMediaWindowLimitError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveImageUrl(value: Record<string, unknown>): string | null {
  if (value.type !== 'image_url' && value.type !== 'input_image') {
    return null;
  }
  if (typeof value.image_url === 'string') {
    return value.image_url;
  }
  if (isRecord(value.image_url) && typeof value.image_url.url === 'string') {
    return value.image_url.url;
  }
  return null;
}

function decodedBytes(url: string): number | null {
  const match = INLINE_IMAGE_PATTERN.exec(url.trim());
  if (!match) {
    return null;
  }
  const encoded = match[1] ?? '';
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) ||
    encoded.slice(0, -2).includes('=')
  ) {
    return null;
  }
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return (encoded.length / 4) * 3 - padding;
}

function itemIdentity(item: unknown): string | null {
  if (!isRecord(item)) {
    return null;
  }
  const id =
    item.type === 'function_call_output' || item.type === 'custom_tool_call_output'
      ? (item.call_id ?? item.id)
      : item.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function matchesCurrentItem(item: unknown, current: unknown): boolean {
  if (
    item === current ||
    (itemIdentity(current) !== null && itemIdentity(item) === itemIdentity(current)) ||
    isEqual(item, current)
  ) {
    return true;
  }
  // Association admission has already assigned a missing call ID. Ignore only
  // that generated field when matching the original, otherwise exact result.
  return (
    isRecord(item) &&
    isRecord(current) &&
    (current.type === 'function_call_output' || current.type === 'custom_tool_call_output') &&
    current.call_id === undefined &&
    current.id === undefined &&
    isEqual({ ...item, call_id: undefined }, { ...current, call_id: undefined })
  );
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(clone);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function replaceAt(root: unknown, path: Array<string | number>): void {
  if (path.length === 0 || !Array.isArray(root)) {
    return;
  }
  let cursor: unknown = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    if (Array.isArray(cursor) && typeof path[index] === 'number') {
      cursor = cursor[path[index] as number];
    } else if (isRecord(cursor) && typeof path[index] === 'string') {
      cursor = cursor[path[index] as string];
    } else {
      return;
    }
  }
  const finalKey = path[path.length - 1];
  if (Array.isArray(cursor) && typeof finalKey === 'number') {
    cursor[finalKey] = { type: 'input_text', text: MEDIA_WINDOW_OMISSION_TEXT };
  } else if (isRecord(cursor) && typeof finalKey === 'string') {
    cursor[finalKey] = MEDIA_WINDOW_OMISSION_TEXT;
  }
}

function collectCandidates(
  value: unknown,
  path: Array<string | number>,
  protectedItem: boolean,
  candidates: ImageCandidate[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectCandidates(entry, [...path, index], protectedItem, candidates);
    });
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  const url = resolveImageUrl(value);
  if (url) {
    const bytes = decodedBytes(url);
    candidates.push({
      slot: {
        inline: bytes !== null,
        bytes: bytes ?? 0,
        protected: protectedItem,
      },
      path,
    });
    return;
  }

  const field =
    value.type === 'function_call_output' || value.type === 'custom_tool_call_output'
      ? 'output'
      : value.type === 'message' || typeof value.role === 'string'
        ? 'content'
        : null;
  if (field) {
    collectCandidates(value[field], [...path, field], protectedItem, candidates);
  }
}

function isWindowEnabled(config: ImageSchedulerConfig | undefined): boolean {
  return config?.send_window_enabled === true;
}

/**
 * Applies the optional history image send window to a Responses input copy.
 *
 * The caller supplies the current request items so every image introduced by
 * this request remains protected. Durable session data is never modified.
 */
export function applyResponsesImageSendWindow(
  items: unknown[],
  config: ImageSchedulerConfig | undefined,
  currentItems: unknown[] = [],
): unknown[] {
  const output = clone(items) as unknown[];
  if (!isWindowEnabled(config)) {
    return output;
  }

  // Match occurrences from the end. Identical repeated screenshots are distinct
  // turns, so equality with one current item cannot protect every historical copy.
  const protectedIndexes = new Set<number>();
  let before = items.length;
  for (const current of currentItems.toReversed()) {
    const index = items.findLastIndex(
      (item, index) => index < before && matchesCurrentItem(item, current),
    );
    if (index >= 0) {
      protectedIndexes.add(index);
      before = index;
    }
  }
  const candidates: ImageCandidate[] = [];
  output.forEach((item, index) => {
    collectCandidates(item, [index], protectedIndexes.has(index), candidates);
  });

  const plan = planMediaSendWindow(
    candidates.map((candidate) => candidate.slot),
    config,
  );
  candidates.forEach((candidate, index) => {
    if (plan.omitted.has(index)) {
      replaceAt(output, candidate.path);
    }
  });
  return output;
}
