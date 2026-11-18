import { validatedImageMimeType } from '../../../server/gateway/common/image-content-validation';
import {
  MAX_INPUT_IMAGE_BYTES,
  MAX_TOTAL_INPUT_IMAGE_BYTES,
} from '../../../server/gateway/modules/openai/media/image-input-validation';
import { recordPromptTransformation } from '../../../server/gateway/common/prompt-transformation-diagnostics';
import type { GeminiPart } from './types';

export const MARKDOWN_BASE64_IMAGE_PATTERN =
  /!\[.*?\]\(data:(image\/[^;]+);base64,([A-Za-z0-9+/=]+)\)/g;

export interface ExtractedToolImageResult {
  text: string;
  media: Array<{ inlineData: NonNullable<GeminiPart['inlineData']> }>;
}

function isCanonicalBase64(data: string): boolean {
  return (
    data.length > 0 &&
    data.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/u.test(data) &&
    !data.slice(0, -2).includes('=') &&
    Buffer.from(data, 'base64').toString('base64') === data
  );
}

function isValidToolImage(mimeType: string, data: string): boolean {
  if (data.length > Math.ceil(MAX_INPUT_IMAGE_BYTES / 3) * 4 || !isCanonicalBase64(data)) {
    return false;
  }
  try {
    return validatedImageMimeType(Buffer.from(data, 'base64')) === mimeType.toLowerCase();
  } catch {
    return false;
  }
}

function isInsideCodeFence(text: string, index: number): boolean {
  const before = text.slice(0, index);
  return (before.match(/^```/gmu)?.length ?? 0) % 2 === 1;
}

const TOOL_IMAGE_FIELDS = new Set(['image', 'screenshot', 'data', 'image_url', 'picture']);
const TOOL_IMAGE_OMISSION = '[image extracted from tool result]';

function recordPreservedCandidate(): void {
  recordPromptTransformation({
    kind: 'tool-image-candidate-preserved',
    surface: 'messages',
    message: null,
    part: null,
  });
}

function toolImageFromDataUrl(value: string): ExtractedToolImageResult['media'][number] | null {
  const match = /^data:(image\/[^;,]+);base64,([\s\S]+)$/iu.exec(value.trim());
  if (match && isValidToolImage(match[1], match[2])) {
    return { inlineData: { mimeType: match[1].toLowerCase(), data: match[2] } };
  }
  if (/^data:image\//iu.test(value.trim())) {
    recordPreservedCandidate();
  }
  return null;
}

function extractStructuredToolImages(text: string): ExtractedToolImageResult | null {
  if (
    !text.trimStart().startsWith('{') ||
    text.length > Math.ceil(MAX_TOTAL_INPUT_IMAGE_BYTES / 3) * 4 + 64 * 1024
  ) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const media: ExtractedToolImageResult['media'] = [];
  for (const key of Object.keys(value)) {
    if (!TOOL_IMAGE_FIELDS.has(key)) {
      continue;
    }
    const candidate: unknown = Reflect.get(value, key);
    if (typeof candidate !== 'string') {
      continue;
    }
    const image = toolImageFromDataUrl(candidate);
    if (image) {
      media.push(image);
      Reflect.set(value, key, TOOL_IMAGE_OMISSION);
    }
  }
  return media.length > 0 ? { text: JSON.stringify(value), media } : null;
}

/**
 * Extracts only unambiguous image candidates from tool output. Invalid
 * candidates remain ordinary tool text so diagnostics are not lost.
 */
export function extractToolResultImages(text: string): ExtractedToolImageResult {
  const structured = extractStructuredToolImages(text);
  if (structured) {
    return structured;
  }
  const standalone = toolImageFromDataUrl(text);
  if (standalone) {
    return { text: TOOL_IMAGE_OMISSION, media: [standalone] };
  }
  const media: ExtractedToolImageResult['media'] = [];
  let output = '';
  let cursor = 0;
  for (const match of text.matchAll(MARKDOWN_BASE64_IMAGE_PATTERN)) {
    const index = match.index ?? 0;
    output += text.slice(cursor, index);
    const mimeType = match[1]?.toLowerCase();
    const data = match[2] ?? '';
    const inFence = isInsideCodeFence(text, index);
    if (!inFence && mimeType && isValidToolImage(mimeType, data)) {
      media.push({ inlineData: { mimeType, data } });
      output += TOOL_IMAGE_OMISSION;
    } else {
      output += match[0];
      if (!inFence) {
        recordPreservedCandidate();
      }
    }
    cursor = index + match[0].length;
  }
  output += text.slice(cursor);
  return { text: output, media };
}

/**
 * Restore Base64 images serialized into Markdown so Gemini receives native
 * image parts instead of spending context tokens on the encoded payload.
 */
export function parseMarkdownImagesToGeminiParts(text: string): GeminiPart[] {
  const parts: GeminiPart[] = [];
  let lastMatchEnd = 0;

  for (const match of text.matchAll(MARKDOWN_BASE64_IMAGE_PATTERN)) {
    const matchIndex = match.index;
    if (matchIndex > lastMatchEnd) {
      const precedingText = text.slice(lastMatchEnd, matchIndex);
      if (precedingText.trim()) {
        parts.push({ text: precedingText });
      }
    }

    parts.push({
      inlineData: {
        mimeType: match[1],
        data: match[2],
      },
    });
    lastMatchEnd = matchIndex + match[0].length;
  }

  if (lastMatchEnd < text.length) {
    const remainingText = text.slice(lastMatchEnd);
    if (remainingText.trim()) {
      parts.push({ text: remainingText });
    }
  }

  if (parts.length === 0 && text.trim()) {
    parts.push({ text });
  }

  return parts;
}
