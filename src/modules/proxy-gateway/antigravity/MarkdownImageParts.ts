import { sniffMimeType } from '../server/modules/files/file-mime-sniff';
import type { GeminiPart } from './types';

export const MARKDOWN_BASE64_IMAGE_PATTERN =
  /!\[.*?\]\(data:(image\/[^;]+);base64,([A-Za-z0-9+/=]+)\)/g;

export interface ExtractedToolImageResult {
  text: string;
  media: GeminiPart[];
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
  if (!isCanonicalBase64(data)) {
    return false;
  }
  const sniffed = sniffMimeType(Buffer.from(data, 'base64'));
  return sniffed?.startsWith('image/') === true && sniffed === mimeType.toLowerCase();
}

function isInsideCodeFence(text: string, index: number): boolean {
  const before = text.slice(0, index);
  return (before.match(/^```/gmu)?.length ?? 0) % 2 === 1;
}

/**
 * Extracts only unambiguous image candidates from tool output. Invalid
 * candidates remain ordinary tool text so diagnostics are not lost.
 */
export function extractToolResultImages(text: string): ExtractedToolImageResult {
  const media: GeminiPart[] = [];
  let output = '';
  let cursor = 0;
  for (const match of text.matchAll(MARKDOWN_BASE64_IMAGE_PATTERN)) {
    const index = match.index ?? 0;
    output += text.slice(cursor, index);
    const mimeType = match[1]?.toLowerCase();
    const data = match[2] ?? '';
    if (!isInsideCodeFence(text, index) && mimeType && isValidToolImage(mimeType, data)) {
      media.push({ inlineData: { mimeType, data } });
      output += '[image extracted from tool result]';
    } else {
      output += match[0];
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
