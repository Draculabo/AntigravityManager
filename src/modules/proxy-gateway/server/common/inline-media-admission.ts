import { BadRequestException } from '@nestjs/common';
import type {
  AnthropicChatRequest,
  AnthropicContent,
  OpenAIChatRequest,
  OpenAIContentPart,
} from './interfaces/request-interfaces';
import {
  normalizeMimeType,
  resolveEffectiveMimeType,
  sniffMimeType,
} from '../modules/files/file-mime-sniff';
import { validateInputImageLimits } from '../modules/openai/media/image-input-validation';
import { resolveOpenAIVideoUrl } from '../modules/openai/chat/openai-video-url';
import { isM4aContainer } from '../modules/openai/chat/openai-input-audio';
import { MARKDOWN_BASE64_IMAGE_PATTERN } from '../../antigravity/MarkdownImageParts';
import { hasExplicitAssistantSignature } from '../../antigravity/signed-assistant-history';

type MediaKind = 'image' | 'document' | 'audio' | 'video';
interface ImageBudget {
  count: number;
  bytes: number;
}
interface InlineSource {
  media_type: string;
  data: string;
}

/** Admission runs before leasing. Media bytes never enter error messages or diagnostic logs. */
function normalizeInlineSource(
  source: InlineSource,
  kind: MediaKind,
  images: ImageBudget,
): InlineSource {
  const mime = normalizeMimeType(source.media_type);
  if (
    !mime ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mime) ||
    (kind !== 'document' && !mime.startsWith(`${kind}/`))
  ) {
    throw new BadRequestException(
      `Inline ${kind} must declare a valid ${kind === 'document' ? 'document' : kind} MIME type`,
    );
  }
  const encoded = source.data;
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new BadRequestException(`Inline ${kind} contains empty or invalid base64 data`);
  }
  // Check the encoded size before allocating a decoded image buffer.
  if (kind === 'image' || mime.startsWith('image/')) {
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    const bytes = (encoded.length / 4) * 3 - padding;
    try {
      validateInputImageLimits(images.count + 1, bytes, images.bytes + bytes);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid inline image size',
      );
    }
    images.count += 1;
    images.bytes += bytes;
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== encoded) {
    throw new BadRequestException(`Inline ${kind} contains invalid base64 data`);
  }
  const sniffed = sniffMimeType(bytes);
  if (sniffed && kind !== 'document' && !sniffed.startsWith(`${kind}/`)) {
    // M4A shares the MP4 container signature; preserve an explicitly declared audio container.
    if (
      !(
        kind === 'audio' &&
        mime === 'audio/mp4' &&
        sniffed === 'video/mp4' &&
        isM4aContainer(bytes)
      )
    ) {
      throw new BadRequestException(
        `Inline ${kind} content does not match its declared media family`,
      );
    }
  }
  if (
    sniffed &&
    kind === 'document' &&
    mime.split('/')[0] !== sniffed.split('/')[0] &&
    resolveEffectiveMimeType(mime, sniffed) !== mime
  ) {
    throw new BadRequestException(
      'Inline document content does not match its declared media family',
    );
  }
  return {
    data: encoded,
    media_type:
      kind === 'audio' && sniffed === 'video/mp4' ? mime : resolveEffectiveMimeType(mime, sniffed),
  };
}

function normalizeDataUrl(
  url: string,
  kind: Exclude<MediaKind, 'document'>,
  images: ImageBudget,
): string {
  const parsed = /^data:([^;,]+)(?:;[^;,]+)*;base64,([\s\S]*)$/iu.exec(url.trim());
  if (!parsed) {
    throw new BadRequestException(`Inline ${kind} must be a base64 data URL`);
  }
  const source = normalizeInlineSource({ media_type: parsed[1], data: parsed[2] }, kind, images);
  return `data:${source.media_type};base64,${source.data}`;
}

function normalizeOpenAIPart(
  part: OpenAIContentPart,
  images: ImageBudget,
  restoresMarkdown: boolean,
): OpenAIContentPart {
  if (part.type === 'text' && part.text && restoresMarkdown) {
    return { ...part, text: normalizeMarkdownImages(part.text, images) };
  }
  if (part.type === 'image_url') {
    const value = part.image_url;
    const url = typeof value === 'string' ? value : value?.url;
    if (url && /^data:/iu.test(url.trim())) {
      const normalized = normalizeDataUrl(url, 'image', images);
      return {
        ...part,
        image_url: typeof value === 'string' ? normalized : { ...value, url: normalized },
      };
    }
  }
  if (part.type === 'audio_url' && part.audio_url && /^data:/iu.test(part.audio_url.url.trim())) {
    return {
      ...part,
      audio_url: { ...part.audio_url, url: normalizeDataUrl(part.audio_url.url, 'audio', images) },
    };
  }
  if (part.type === 'video_url') {
    if (part.video_url && /^data:/iu.test(part.video_url.url.trim())) {
      return {
        ...part,
        video_url: {
          ...part.video_url,
          url: normalizeDataUrl(part.video_url.url, 'video', images),
        },
      };
    }
    // The existing resolver distinguishes remote URLs and disabled local paths from raw base64.
    const source = resolveOpenAIVideoUrl(part.video_url);
    if (source?.type === 'base64') {
      const normalized = normalizeInlineSource(source, 'video', images);
      return {
        ...part,
        video_url: { ...part.video_url, url: normalized.data, mime_type: normalized.media_type },
      };
    }
  }
  return part;
}

export function admitOpenAIInlineMedia(request: OpenAIChatRequest): OpenAIChatRequest {
  const images = { count: 0, bytes: 0 };
  return {
    ...request,
    messages: request.messages.map((message) => {
      const restoresMarkdown = !['system', 'developer', 'tool'].includes(message.role);
      return {
        ...message,
        content: Array.isArray(message.content)
          ? message.content.map((part) => normalizeOpenAIPart(part, images, restoresMarkdown))
          : typeof message.content === 'string' && restoresMarkdown
            ? normalizeMarkdownImages(message.content, images)
            : message.content,
      };
    }),
  };
}

function normalizeAnthropicContent(
  content: string | AnthropicContent[],
  images: ImageBudget,
  restoresMarkdown: boolean,
): string | AnthropicContent[] {
  if (typeof content === 'string') {
    return restoresMarkdown ? normalizeMarkdownImages(content, images) : content;
  }
  return content.map((block): AnthropicContent => {
    if (block.type === 'text' && restoresMarkdown) {
      return { ...block, text: normalizeMarkdownImages(block.text, images) };
    }
    if (block.type === 'tool_result') {
      return { ...block, content: normalizeAnthropicContent(block.content, images, false) };
    }
    if (
      (block.type === 'image' ||
        block.type === 'document' ||
        block.type === 'audio' ||
        block.type === 'video') &&
      block.source.type === 'base64'
    ) {
      return {
        ...block,
        source: { type: 'base64', ...normalizeInlineSource(block.source, block.type, images) },
      };
    }
    return block;
  });
}

function normalizeMarkdownImages(text: string, images: ImageBudget): string {
  // Share the mapper's grammar so prose that is not converted to media stays prose.
  return text.replace(MARKDOWN_BASE64_IMAGE_PATTERN, (match, mime: string, data: string) => {
    const normalized = normalizeInlineSource({ media_type: mime, data }, 'image', images);
    return match.replace(
      `data:${mime};base64,${data}`,
      `data:${normalized.media_type};base64,${data}`,
    );
  });
}

export function admitAnthropicInlineMedia(request: AnthropicChatRequest): AnthropicChatRequest {
  const images = { count: 0, bytes: 0 };
  return {
    ...request,
    messages: request.messages.map((message) => ({
      ...message,
      content: normalizeAnthropicContent(
        message.content,
        images,
        message.role !== 'system' && !hasExplicitAssistantSignature(message.role, message.content),
      ),
    })),
  };
}
