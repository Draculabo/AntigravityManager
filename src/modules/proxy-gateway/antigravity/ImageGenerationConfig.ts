import type { ImageConfig, SafetySetting } from './types';

export const IMAGE_GENERATION_SAFETY_SETTINGS: SafetySetting[] = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
];

export interface ImageGenerationConfigInput {
  imageSize?: string;
  quality?: string;
  size?: string;
}

const ASPECT_RATIOS = [
  ['21:9', 21 / 9],
  ['16:9', 16 / 9],
  ['4:3', 4 / 3],
  ['3:4', 3 / 4],
  ['9:16', 9 / 16],
  ['3:2', 3 / 2],
  ['2:3', 2 / 3],
  ['5:4', 5 / 4],
  ['4:5', 4 / 5],
  ['1:1', 1],
] as const;

const MODEL_ASPECT_RATIOS = [
  '21:9',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '5:4',
  '4:5',
  '1:1',
] as const;

const MODEL_SUFFIXES = [
  '-4k',
  '-2k',
  '-1k',
  '-hd',
  '-standard',
  '-medium',
  '-21x9',
  '-21-9',
  '-16x9',
  '-16-9',
  '-9x16',
  '-9-16',
  '-4x3',
  '-4-3',
  '-3x4',
  '-3-4',
  '-3x2',
  '-3-2',
  '-2x3',
  '-2-3',
  '-5x4',
  '-5-4',
  '-4x5',
  '-4-5',
  '-1x1',
  '-1-1',
] as const;

export function normalizeExplicitImageSize(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error('Invalid image_size: expected one of 1K, 2K, 4K, or auto');
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'auto') {
    return undefined;
  }
  if (normalized === '1k' || normalized === '2k' || normalized === '4k') {
    return normalized.toUpperCase();
  }
  throw new Error('Invalid image_size: expected one of 1K, 2K, 4K, or auto');
}

export function imageAspectRatioFromSize(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === 'auto') {
    return undefined;
  }

  const direct = ASPECT_RATIOS.find(([aspectRatio]) => aspectRatio === normalized);
  if (direct) {
    return direct[0];
  }

  const dimensions = normalized.split('x');
  if (dimensions.length !== 2) {
    return undefined;
  }
  if (dimensions.some((dimension) => !dimension || dimension.trim() !== dimension)) {
    return undefined;
  }
  const width = Number(dimensions[0]);
  const height = Number(dimensions[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }

  const ratio = width / height;
  return ASPECT_RATIOS.find(([, expected]) => Math.abs(ratio - expected) < 0.05)?.[0];
}

function imageSizeFromQuality(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  switch (value.trim().toLowerCase()) {
    case 'low':
    case 'standard':
    case '1k':
      return '1K';
    case 'medium':
    case '2k':
      return '2K';
    case 'high':
    case 'hd':
    case '4k':
      return '4K';
    default:
      return undefined;
  }
}

export function selectImageAspectRatioInput(
  preferred: string | undefined,
  fallback: string | undefined,
): string | undefined {
  if (imageAspectRatioFromSize(preferred)) {
    return preferred;
  }
  if (imageAspectRatioFromSize(fallback)) {
    return fallback;
  }
  return undefined;
}

function imageAspectRatioFromModel(modelName: string): string {
  const normalized = modelName.toLowerCase();
  for (const aspectRatio of MODEL_ASPECT_RATIOS) {
    const [width, height] = aspectRatio.split(':');
    if (normalized.includes(`-${width}x${height}`) || normalized.includes(`-${width}-${height}`)) {
      return aspectRatio;
    }
  }
  return '1:1';
}

function imageSizeFromModel(modelName: string): string | undefined {
  const normalized = modelName.toLowerCase();
  if (normalized.includes('-4k') || normalized.includes('-hd')) {
    return '4K';
  }
  if (normalized.includes('-2k')) {
    return '2K';
  }
  if (normalized.includes('-1k') || normalized.includes('-standard')) {
    return '1K';
  }
  return undefined;
}

export function cleanImageModelName(modelName: string): string {
  let normalized = modelName.toLowerCase();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of MODEL_SUFFIXES) {
      if (normalized.endsWith(suffix)) {
        normalized = normalized.slice(0, -suffix.length);
        changed = true;
      }
    }
  }

  return normalized;
}

export function resolveImageGenerationConfig(
  modelName: string,
  input: ImageGenerationConfigInput = {},
): { imageConfig: ImageConfig; parsedBaseModel: string } {
  const imageConfig: ImageConfig = {
    aspectRatio: imageAspectRatioFromSize(input.size) ?? imageAspectRatioFromModel(modelName),
  };
  const imageSize =
    normalizeExplicitImageSize(input.imageSize) ??
    imageSizeFromQuality(input.quality) ??
    imageSizeFromModel(modelName);
  if (imageSize) {
    imageConfig.imageSize = imageSize;
  }

  return {
    imageConfig,
    parsedBaseModel: cleanImageModelName(modelName),
  };
}
