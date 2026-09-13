import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from '@/shared/logging/logger';
import type {
  AnthropicContent,
  OpenAIContentPart,
} from '../../../common/interfaces/request-interfaces';

const INLINE_VIDEO_SIZE_WARNING_BYTES = 20 * 1024 * 1024;

type VideoSource = Extract<AnthropicContent, { type: 'video' }>['source'];

export interface OpenAIVideoUrlOptions {
  allowLocalPaths?: boolean;
}

export function normalizeVideoMime(format: string): string {
  const normalized = format.trim().toLowerCase();
  const bare = normalized.startsWith('video/') ? normalized.slice('video/'.length) : normalized;

  switch (bare) {
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mov':
    case 'quicktime':
      return 'video/quicktime';
    case 'avi':
    case 'x-msvideo':
      return 'video/x-msvideo';
    case 'wmv':
    case 'x-ms-wmv':
      return 'video/x-ms-wmv';
    case 'flv':
    case 'x-flv':
      return 'video/x-flv';
    case 'mkv':
    case 'x-matroska':
      return 'video/x-matroska';
    case '3gp':
    case '3gpp':
      return 'video/3gpp';
    default:
      return `video/${bare}`;
  }
}

function inferVideoMime(value: string): string {
  const clean = value.split(/[?#]/u, 1)[0] ?? value;
  const extension = path.extname(clean).slice(1).toLowerCase();
  if (!['mp4', 'm4v', 'webm', 'mov', 'avi', 'wmv', 'flv', 'mkv', '3gp'].includes(extension)) {
    return 'video/mp4';
  }

  return normalizeVideoMime(extension);
}

function warnIfOversizedBase64(base64Length: number, mimeType: string): void {
  const estimatedBytes = Math.floor((base64Length * 3) / 4);
  if (estimatedBytes > INLINE_VIDEO_SIZE_WARNING_BYTES) {
    logger.warn(
      `[OpenAI-Video] Inline ${mimeType} content is approximately ${estimatedBytes} bytes, above the 20 MiB recommended limit`,
    );
  }
}

function resolveExistingLocalPath(source: string): string | null {
  if (source.startsWith('file://')) {
    try {
      const filePath = fileURLToPath(source);
      return fs.statSync(filePath).isFile() ? filePath : '';
    } catch {
      return '';
    }
  }

  if (source.length >= 4096) {
    return null;
  }

  try {
    return fs.statSync(source).isFile() ? source : null;
  } catch {
    return null;
  }
}

function isExplicitLocalPath(source: string): boolean {
  return (
    source.startsWith('file://') ||
    path.isAbsolute(source) ||
    path.win32.isAbsolute(source) ||
    source.startsWith('./') ||
    source.startsWith('../') ||
    source.startsWith('.\\') ||
    source.startsWith('..\\')
  );
}

/**
 * Maps the compatible `video_url` envelope to the internal media source.
 * Local paths are the only source gated by user configuration; data URLs, HTTP(S)
 * URLs and raw base64 keep the gateway's documented order and fallback behavior.
 */
export function resolveOpenAIVideoUrl(
  value: OpenAIContentPart['video_url'],
  options: OpenAIVideoUrlOptions = {},
): VideoSource | null {
  if (!value || typeof value.url !== 'string') {
    return null;
  }

  const source = value.url;
  const declaredValue = value.mime_type ?? value.mimeType ?? value.format;
  const declaredMime =
    typeof declaredValue === 'string' ? normalizeVideoMime(declaredValue) : undefined;

  if (source.startsWith('data:')) {
    const separator = source.indexOf(',');
    if (separator < 0) {
      return null;
    }

    const metadata = source.slice('data:'.length, separator);
    const metadataMime = metadata.split(';', 1)[0] ?? '';
    const mimeType = metadataMime.includes('/')
      ? normalizeVideoMime(metadataMime)
      : (declaredMime ?? 'video/mp4');
    const data = source.slice(separator + 1);
    warnIfOversizedBase64(data.length, mimeType);
    return { type: 'base64', media_type: mimeType, data };
  }

  if (source.startsWith('http://') || source.startsWith('https://')) {
    return {
      type: 'url',
      media_type: declaredMime ?? inferVideoMime(source),
      url: source,
    };
  }

  if (!options.allowLocalPaths) {
    if (isExplicitLocalPath(source)) {
      return null;
    }

    if (source === '') {
      return null;
    }

    const mimeType = declaredMime ?? 'video/mp4';
    warnIfOversizedBase64(source.length, mimeType);
    return { type: 'base64', media_type: mimeType, data: source };
  }

  const localPath = resolveExistingLocalPath(source);
  if (localPath !== null) {
    if (localPath === '') {
      return null;
    }

    try {
      const bytes = fs.readFileSync(localPath);
      if (bytes.byteLength > INLINE_VIDEO_SIZE_WARNING_BYTES) {
        logger.warn(
          `[OpenAI-Video] Local video is ${bytes.byteLength} bytes, above the 20 MiB recommended limit: ${localPath}`,
        );
      }
      return {
        type: 'base64',
        media_type: declaredMime ?? inferVideoMime(localPath),
        data: bytes.toString('base64'),
      };
    } catch (error) {
      logger.warn(`[OpenAI-Video] Failed to read local video path: ${localPath}`, error);
      return null;
    }
  }

  if (source === '') {
    return null;
  }

  const mimeType = declaredMime ?? 'video/mp4';
  warnIfOversizedBase64(source.length, mimeType);
  return { type: 'base64', media_type: mimeType, data: source };
}
