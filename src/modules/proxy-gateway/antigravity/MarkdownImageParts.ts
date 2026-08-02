import type { GeminiPart } from './types';

const MARKDOWN_BASE64_IMAGE_PATTERN = /!\[.*?\]\(data:(image\/[^;]+);base64,([A-Za-z0-9+/=]+)\)/g;

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
