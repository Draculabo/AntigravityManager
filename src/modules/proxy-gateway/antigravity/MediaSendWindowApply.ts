import type { ImageSchedulerConfig } from '@/modules/config/types';
import {
  MEDIA_WINDOW_OMISSION_TEXT,
  planMediaSendWindow,
} from '../../../server/gateway/common/media-send-window';
import type { GeminiContent, GeminiPart } from './types';

const BASE64_IMAGE_DATA_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;

function decodedInlineImageBytes(data: string): number | null {
  const encoded = data.trim();
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !BASE64_IMAGE_DATA_PATTERN.test(encoded) ||
    encoded.slice(0, -2).includes('=')
  ) {
    return null;
  }
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return (encoded.length / 4) * 3 - padding;
}

interface GeminiMediaSlot {
  contentIndex: number;
  partIndex: number;
  inline: boolean;
  bytes: number;
  protected: boolean;
}

function isImageMime(mimeType: string | undefined): boolean {
  return Boolean(mimeType?.toLowerCase().startsWith('image/'));
}

function collectGeminiMediaSlots(
  contents: GeminiContent[],
  protectedContentIndexes: ReadonlySet<number>,
): GeminiMediaSlot[] {
  const slots: GeminiMediaSlot[] = [];
  contents.forEach((content, contentIndex) => {
    const protectedItem = protectedContentIndexes.has(contentIndex);
    content.parts.forEach((part: GeminiPart, partIndex) => {
      if (part.inlineData && isImageMime(part.inlineData.mimeType)) {
        const bytes = decodedInlineImageBytes(part.inlineData.data);
        if (bytes !== null) {
          slots.push({ contentIndex, partIndex, inline: true, bytes, protected: protectedItem });
        }
      } else if (part.fileData && isImageMime(part.fileData.mimeType)) {
        // Remote files have no measurable decoded size; the planner keeps them
        // unless explicit remote stripping is enabled (D07 R5).
        slots.push({ contentIndex, partIndex, inline: false, bytes: 0, protected: protectedItem });
      }
    });
  });
  return slots;
}

/**
 * Current-operation boundary: everything after the last model turn, including
 * the trailing user/tool-result media, is protected from the window.
 */
export function resolveProtectedGeminiContentIndexes(contents: GeminiContent[]): Set<number> {
  const lastModelIndex = contents.findLastIndex((content) => content.role === 'model');
  return new Set(contents.map((_, index) => index).filter((index) => index > lastModelIndex));
}

export function applyGeminiMediaSendWindow(
  contents: GeminiContent[],
  config: ImageSchedulerConfig | undefined,
  protectedContentIndexes: ReadonlySet<number> = resolveProtectedGeminiContentIndexes(contents),
): GeminiContent[] {
  if (config?.send_window_enabled !== true) {
    return contents;
  }
  const slots = collectGeminiMediaSlots(contents, protectedContentIndexes);
  const plan = planMediaSendWindow(
    slots.map(({ inline, bytes, protected: protectedItem }) => ({
      inline,
      bytes,
      protected: protectedItem,
    })),
    config,
  );
  slots.forEach((slot, index) => {
    if (plan.omitted.has(index)) {
      contents[slot.contentIndex].parts[slot.partIndex] = {
        text: MEDIA_WINDOW_OMISSION_TEXT,
      };
    }
  });
  return contents;
}
