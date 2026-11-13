import type {
  AnthropicContent,
  GeminiPart,
  OpenAIContentPart,
  OpenAIMessage,
} from './interfaces/request-interfaces';
import { hashSessionAnchor } from './session-anchor-hash';

export interface InlineImageAnchor {
  kind: 'inline-image';
  mimeType: string;
  fingerprint: string;
}

interface InlineMediaAnchor {
  kind: 'inline-media';
  mimeType: string;
  fingerprint: string;
  title?: string;
}

interface MediaReferenceAnchor {
  kind: 'media-reference';
  mediaKind: 'image' | 'audio' | 'video' | 'document';
  mimeType: string;
  fingerprint: string;
}

export type SessionTaskPart = string | InlineImageAnchor | InlineMediaAnchor | MediaReferenceAnchor;

const AUDIO_FORMAT_MIME_TYPES: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  mpeg: 'audio/mpeg',
  mpga: 'audio/mpeg',
  wav: 'audio/wav',
  wave: 'audio/wav',
  'x-wav': 'audio/wav',
  'vnd.wave': 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  'x-flac': 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  'x-m4a': 'audio/mp4',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  'x-aiff': 'audio/aiff',
};

// Avoid repeated groups: valid multi-MiB media can exhaust the RegExp engine's stack.
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;
const MIME_TYPE_PATTERN = /^(?:image|audio|video|application)\/[a-z0-9!#$&^_.+-]+$/u;

export function hasOnlySessionFields(value: object, fields: string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}

/** Fingerprint the admitted encoded content without decoding or serializing the full media. */
function imageAnchor(mime: string, data: string): InlineImageAnchor | undefined {
  const mimeType = mime.trim().toLowerCase();
  if (!data || !/^image\/[a-z0-9!#$&^_.+-]+$/u.test(mimeType)) {
    return undefined;
  }
  return { kind: 'inline-image', mimeType, fingerprint: hashSessionAnchor(data) };
}

function canonicalMediaType(value: string): string | undefined {
  const mimeType = value.trim().toLowerCase();
  if (!MIME_TYPE_PATTERN.test(mimeType)) {
    return undefined;
  }

  if (mimeType.startsWith('image/')) {
    return mimeType;
  }
  if (mimeType.startsWith('audio/')) {
    const format = mimeType.slice('audio/'.length);
    return AUDIO_FORMAT_MIME_TYPES[format] ?? mimeType;
  }
  if (mimeType.startsWith('video/')) {
    return normalizeVideoMime(mimeType);
  }
  return mimeType;
}

function normalizeVideoMime(value: string): string {
  const bare = value
    .trim()
    .toLowerCase()
    .replace(/^video\//u, '');
  switch (bare) {
    case 'mp4':
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

function mediaKind(mimeType: string): MediaReferenceAnchor['mediaKind'] {
  const topLevelType = mimeType.slice(0, mimeType.indexOf('/'));
  if (topLevelType === 'image' || topLevelType === 'audio' || topLevelType === 'video') {
    return topLevelType;
  }
  return 'document';
}

function inlineMediaAnchor(mime: string, data: string): SessionTaskPart | undefined {
  const mimeType = canonicalMediaType(mime);
  if (!mimeType || !data) {
    return undefined;
  }
  if (mimeType.startsWith('image/')) {
    return imageAnchor(mime, data);
  }
  if (data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
    return undefined;
  }
  return {
    kind: 'inline-media',
    mimeType,
    fingerprint: hashSessionAnchor(data),
  };
}

function parseBase64DataUrl(value: string): { mimeType: string; data: string } | undefined {
  if (!value.startsWith('data:')) {
    return undefined;
  }
  const separator = value.indexOf(',');
  if (separator < 5 || separator > 512) {
    return undefined;
  }
  const metadata = value.slice('data:'.length, separator).split(';');
  const mimeType = metadata[0] ?? '';
  const data = value.slice(separator + 1);
  if (
    !metadata.slice(1).some((parameter) => parameter.toLowerCase() === 'base64') ||
    !canonicalMediaType(mimeType) ||
    !data ||
    data.length % 4 !== 0 ||
    !BASE64_PATTERN.test(data)
  ) {
    return undefined;
  }
  return { mimeType, data };
}

function referenceAnchor(
  kind: MediaReferenceAnchor['mediaKind'],
  mime: string | undefined,
  reference: string,
): MediaReferenceAnchor | undefined {
  const mimeType = mime ? canonicalMediaType(mime) : undefined;
  if (!mimeType || mediaKind(mimeType) !== kind || !reference || reference !== reference.trim()) {
    return undefined;
  }
  let normalizedReference: string;
  try {
    const parsed = new URL(reference);
    if (
      !['http:', 'https:', 'gs:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    normalizedReference = parsed.href;
  } catch {
    return undefined;
  }
  return {
    kind: 'media-reference',
    mediaKind: kind,
    mimeType,
    fingerprint: hashSessionAnchor(normalizedReference),
  };
}

function audioFormatMimeType(format: string | undefined): string | undefined {
  const normalized = (format ?? 'mp3')
    .trim()
    .toLowerCase()
    .replace(/^audio\//u, '');
  return AUDIO_FORMAT_MIME_TYPES[normalized];
}

function inferredAudioMimeType(reference: string): string | undefined {
  let pathname = reference;
  try {
    pathname = new URL(reference).pathname;
  } catch {
    pathname = reference;
  }
  const extension = /\.([a-z0-9]+)$/iu.exec(pathname)?.[1]?.toLowerCase();
  return extension ? audioFormatMimeType(extension) : undefined;
}

function inputAudioAnchor(part: OpenAIContentPart): SessionTaskPart | undefined {
  const audio = part.input_audio;
  if (
    !audio ||
    !hasOnlySessionFields(audio, ['data', 'format']) ||
    typeof audio.data !== 'string' ||
    (audio.format !== undefined && typeof audio.format !== 'string')
  ) {
    return undefined;
  }

  const raw = audio.data.trim();
  const dataUrl = parseBase64DataUrl(raw);
  if (dataUrl) {
    return dataUrl.mimeType.startsWith('audio/')
      ? inlineMediaAnchor(dataUrl.mimeType, dataUrl.data)
      : undefined;
  }
  const mimeType = audioFormatMimeType(audio.format);
  return mimeType ? inlineMediaAnchor(mimeType, raw) : undefined;
}

function optionalMediaFieldsAreStrings(value: object, fields: string[]): boolean {
  return fields.every((field) => {
    const item = Reflect.get(value, field);
    return item === undefined || typeof item === 'string';
  });
}

function dataUrlOrReference(
  kind: MediaReferenceAnchor['mediaKind'],
  value: string,
  mimeType?: string,
  allowedProtocols: readonly string[] = ['http:', 'https:', 'gs:'],
): SessionTaskPart | undefined {
  const dataUrl = parseBase64DataUrl(value);
  if (dataUrl) {
    const canonicalDataMime = canonicalMediaType(dataUrl.mimeType);
    const canonicalExpectedMime = mimeType ? canonicalMediaType(mimeType) : undefined;
    return canonicalDataMime &&
      mediaKind(canonicalDataMime) === kind &&
      (!canonicalExpectedMime || canonicalExpectedMime === canonicalDataMime)
      ? inlineMediaAnchor(dataUrl.mimeType, dataUrl.data)
      : undefined;
  }

  const anchor = referenceAnchor(kind, mimeType, value);
  if (!anchor) {
    return undefined;
  }
  try {
    return allowedProtocols.includes(new URL(value).protocol) ? anchor : undefined;
  } catch {
    return undefined;
  }
}

function inferredVideoMimeType(reference: string): string {
  let pathname = reference;
  try {
    pathname = new URL(reference).pathname;
  } catch {
    pathname = reference;
  }
  const extension = /\.([a-z0-9]+)$/iu.exec(pathname)?.[1]?.toLowerCase();
  return extension === 'm4v' ? 'ambiguous' : normalizeVideoMime(extension ?? 'mp4');
}

function referencedVideoMimeType(reference: string): string | undefined {
  let pathname = reference;
  try {
    pathname = new URL(reference).pathname;
  } catch {
    pathname = reference;
  }
  const extension = /\.([a-z0-9]+)$/iu.exec(pathname)?.[1]?.toLowerCase();
  if (!extension || extension === 'm4v') {
    return undefined;
  }
  return canonicalMediaType(normalizeVideoMime(extension));
}

function openAIAudioUrlTask(value: OpenAIContentPart['audio_url']): SessionTaskPart | undefined {
  if (
    !value ||
    !hasOnlySessionFields(value, ['url', 'mime_type', 'mimeType', 'format']) ||
    !optionalMediaFieldsAreStrings(value, ['mime_type', 'mimeType', 'format'])
  ) {
    return undefined;
  }
  const declaredMime = value.mime_type ?? value.mimeType ?? value.format;
  const mimeType = declaredMime
    ? (audioFormatMimeType(declaredMime) ??
      (declaredMime.toLowerCase().startsWith('audio/')
        ? canonicalMediaType(declaredMime)
        : undefined))
    : inferredAudioMimeType(value.url);
  if (
    (declaredMime !== undefined && !mimeType) ||
    (mimeType !== undefined && mediaKind(mimeType) !== 'audio')
  ) {
    return undefined;
  }
  return dataUrlOrReference('audio', value.url, mimeType, ['http:', 'https:']);
}

function openAIVideoUrlTask(value: OpenAIContentPart['video_url']): SessionTaskPart | undefined {
  if (
    !value ||
    !hasOnlySessionFields(value, ['url', 'mime_type', 'mimeType', 'format']) ||
    !optionalMediaFieldsAreStrings(value, ['mime_type', 'mimeType', 'format'])
  ) {
    return undefined;
  }
  const declared = value.mime_type ?? value.mimeType ?? value.format;
  const canonicalDeclared = declared ? normalizeVideoMime(declared) : undefined;
  const declaredMimeType = canonicalDeclared ? canonicalMediaType(canonicalDeclared) : undefined;
  const mimeType = declaredMimeType ?? referencedVideoMimeType(value.url);
  if (declared && !declaredMimeType) {
    return undefined;
  }
  if (value.url.startsWith('data:')) {
    return dataUrlOrReference('video', value.url, declaredMimeType, ['http:', 'https:']);
  }
  if (value.url.startsWith('http://') || value.url.startsWith('https://')) {
    return dataUrlOrReference('video', value.url, mimeType, ['http:', 'https:']);
  }
  if (value.url.length % 4 === 0 && BASE64_PATTERN.test(value.url)) {
    const inferred = inferredVideoMimeType(value.url);
    return inferred === 'ambiguous'
      ? undefined
      : inlineMediaAnchor(mimeType ?? inferred, value.url);
  }
  return undefined;
}

export function openAIMediaTask(content: OpenAIMessage['content']): SessionTaskPart[] | undefined {
  if (typeof content === 'string') {
    return [content];
  }
  if (!content) {
    return [];
  }
  const result: SessionTaskPart[] = [];
  for (const part of content) {
    if (part.type === 'text' && hasOnlySessionFields(part, ['type', 'text'])) {
      result.push(part.text ?? '');
      continue;
    }
    if (part.type === 'image_url' && hasOnlySessionFields(part, ['type', 'image_url'])) {
      const image = part.image_url;
      if (!image) {
        return undefined;
      }
      if (
        typeof image !== 'string' &&
        (!hasOnlySessionFields(image, ['url', 'detail']) ||
          (image.detail !== undefined && image.detail !== 'auto'))
      ) {
        return undefined;
      }
      const url = typeof image === 'string' ? image : image.url;
      const dataUrl = parseBase64DataUrl(url);
      const anchor = dataUrl?.mimeType.startsWith('image/')
        ? inlineMediaAnchor(dataUrl.mimeType, dataUrl.data)
        : undefined;
      if (!anchor) {
        return undefined;
      }
      result.push(anchor);
      continue;
    }
    if (
      (part.type === 'input_audio' || part.type === 'audio') &&
      hasOnlySessionFields(part, ['type', 'input_audio'])
    ) {
      const anchor = inputAudioAnchor(part);
      if (!anchor) {
        return undefined;
      }
      result.push(anchor);
      continue;
    }
    if (part.type === 'audio_url' && hasOnlySessionFields(part, ['type', 'audio_url'])) {
      const anchor = openAIAudioUrlTask(part.audio_url);
      if (!anchor) {
        return undefined;
      }
      result.push(anchor);
      continue;
    }
    if (part.type === 'video_url' && hasOnlySessionFields(part, ['type', 'video_url'])) {
      const anchor = openAIVideoUrlTask(part.video_url);
      if (!anchor) {
        return undefined;
      }
      result.push(anchor);
      continue;
    }
    return undefined;
  }
  return result;
}

function anthropicSourceAnchor(
  kind: MediaReferenceAnchor['mediaKind'],
  source: { type: string; media_type: string; data?: string; url?: string },
): SessionTaskPart | undefined {
  const mimeType = canonicalMediaType(source.media_type);
  if (!mimeType || mediaKind(mimeType) !== kind) {
    return undefined;
  }
  if (source.type === 'base64' && typeof source.data === 'string') {
    return inlineMediaAnchor(mimeType, source.data);
  }
  if (
    source.type === 'url' &&
    typeof source.url === 'string' &&
    kind !== 'image' &&
    kind !== 'document'
  ) {
    return dataUrlOrReference(kind, source.url, mimeType, ['http:', 'https:']);
  }
  return undefined;
}

export function anthropicMediaTask(
  content: string | AnthropicContent[] | undefined,
): SessionTaskPart[] | undefined {
  if (typeof content === 'string') {
    return [content];
  }
  if (!content) {
    return undefined;
  }
  const result: SessionTaskPart[] = [];
  for (const block of content) {
    if (block.type === 'text' && hasOnlySessionFields(block, ['type', 'text'])) {
      result.push(block.text);
      continue;
    }
    if (block.type === 'image' || block.type === 'document') {
      if (
        !hasOnlySessionFields(
          block,
          block.type === 'document' ? ['type', 'source', 'title'] : ['type', 'source'],
        ) ||
        (block.type === 'document' &&
          block.title !== undefined &&
          typeof block.title !== 'string') ||
        block.source.type !== 'base64' ||
        !hasOnlySessionFields(block.source, ['type', 'media_type', 'data'])
      ) {
        return undefined;
      }
      const kind = block.type === 'image' ? 'image' : 'document';
      const anchor = anthropicSourceAnchor(kind, block.source);
      if (!anchor) {
        return undefined;
      }
      result.push(
        block.type === 'document' &&
          block.title !== undefined &&
          typeof anchor !== 'string' &&
          anchor.kind === 'inline-media'
          ? { ...anchor, title: block.title }
          : anchor,
      );
      continue;
    }
    if (block.type === 'audio' || block.type === 'video') {
      if (!hasOnlySessionFields(block, ['type', 'source'])) {
        return undefined;
      }
      const kind = block.type;
      const allowedSourceFields =
        block.source.type === 'base64'
          ? ['type', 'media_type', 'data']
          : ['type', 'media_type', 'url'];
      if (!hasOnlySessionFields(block.source, allowedSourceFields)) {
        return undefined;
      }
      const anchor = anthropicSourceAnchor(kind, block.source);
      if (!anchor) {
        return undefined;
      }
      result.push(anchor);
      continue;
    }
    return undefined;
  }
  return result;
}

export function geminiMediaTask(parts: GeminiPart[] | undefined): SessionTaskPart[] | undefined {
  if (!parts) {
    return undefined;
  }
  const result: SessionTaskPart[] = [];
  for (const part of parts) {
    if (typeof part.text === 'string' && hasOnlySessionFields(part, ['text'])) {
      result.push(part.text);
      continue;
    }
    if (
      part.inlineData &&
      hasOnlySessionFields(part, ['inlineData']) &&
      hasOnlySessionFields(part.inlineData, ['mimeType', 'data']) &&
      typeof part.inlineData.mimeType === 'string' &&
      typeof part.inlineData.data === 'string'
    ) {
      const anchor = inlineMediaAnchor(part.inlineData.mimeType, part.inlineData.data);
      if (!anchor) {
        return undefined;
      }
      result.push(anchor);
      continue;
    }
    if (
      part.fileData &&
      hasOnlySessionFields(part, ['fileData']) &&
      hasOnlySessionFields(part.fileData, ['fileUri', 'mimeType']) &&
      typeof part.fileData.fileUri === 'string' &&
      typeof part.fileData.mimeType === 'string'
    ) {
      const mimeType = canonicalMediaType(part.fileData.mimeType);
      if (!mimeType) {
        return undefined;
      }
      const anchor = referenceAnchor(mediaKind(mimeType), mimeType, part.fileData.fileUri);
      if (!anchor) {
        return undefined;
      }
      result.push(anchor);
      continue;
    }
    return undefined;
  }
  return result;
}
