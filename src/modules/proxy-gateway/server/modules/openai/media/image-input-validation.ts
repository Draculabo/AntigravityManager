import type { ImageMonitoringInput } from './image-monitoring-summary';

export const MAX_INPUT_IMAGES = 16;
export const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_INPUT_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_GENERATION_BODY_BYTES =
  Math.ceil(MAX_TOTAL_INPUT_IMAGE_BYTES / 3) * 4 + 1024 * 1024;

export function validateInputImageLimits(
  imageCount: number,
  imageBytes: number,
  totalBytes: number,
): void {
  if (imageCount > MAX_INPUT_IMAGES) {
    throw new Error(`Too many input images: maximum is ${MAX_INPUT_IMAGES}`);
  }
  if (imageBytes > MAX_INPUT_IMAGE_BYTES) {
    throw new Error(
      `Input image is too large: maximum decoded size is ${MAX_INPUT_IMAGE_BYTES} bytes`,
    );
  }
  if (totalBytes > MAX_TOTAL_INPUT_IMAGE_BYTES) {
    throw new Error(
      `Total input image data is too large: maximum decoded size is ${MAX_TOTAL_INPUT_IMAGE_BYTES} bytes`,
    );
  }
}

export function parseInputImageDataUrl(
  dataUrl: string,
  imageCount: number,
  totalBytes: number,
): { image: ImageMonitoringInput; decodedBytes: number } {
  if (!dataUrl.startsWith('data:')) {
    throw new Error('Input image must be a base64 data:image URL');
  }
  const separator = dataUrl.indexOf(',');
  if (separator < 0) {
    throw new Error('Input image must be a base64 data:image URL');
  }

  const metadata = dataUrl.slice('data:'.length, separator);
  const metadataParts = metadata.split(';');
  const mimeType = metadataParts[0] ?? '';
  if (!mimeType.startsWith('image/') || mimeType.length <= 'image/'.length) {
    throw new Error('Input image data URL must use an image MIME type');
  }
  if (!metadataParts.slice(1).some((part) => part.toLowerCase() === 'base64')) {
    throw new Error('Input image data URL must be base64 encoded');
  }

  const encoded = dataUrl.slice(separator + 1);
  if (!encoded) {
    throw new Error('Input image data URL is empty');
  }
  const maxEncodedLength = Math.ceil(MAX_INPUT_IMAGE_BYTES / 3) * 4;
  if (encoded.length > maxEncodedLength) {
    throw new Error(
      `Input image is too large: maximum decoded size is ${MAX_INPUT_IMAGE_BYTES} bytes`,
    );
  }
  if (
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) ||
    encoded.slice(0, -2).includes('=')
  ) {
    throw new Error('Input image contains invalid base64 data');
  }

  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) {
    throw new Error('Input image contains invalid base64 data');
  }
  const nextTotal = totalBytes + decoded.length;
  validateInputImageLimits(imageCount, decoded.length, nextTotal);
  return {
    image: {
      data: encoded,
      mimeType,
    },
    decodedBytes: decoded.length,
  };
}

export function parseGenerationInputImages(input: unknown): ImageMonitoringInput[] {
  if (input === undefined) {
    return [];
  }

  let urls: string[];
  if (typeof input === 'string') {
    urls = [input];
  } else if (Array.isArray(input)) {
    if (input.length === 0) {
      throw new Error('Input image array must not be empty');
    }
    if (!input.every((value): value is string => typeof value === 'string')) {
      throw new Error('Every input image must be a base64 data:image URL');
    }
    urls = input;
  } else {
    throw new Error('Input image must be a string or an array of strings');
  }

  validateInputImageLimits(urls.length, 0, 0);
  const images: ImageMonitoringInput[] = [];
  let totalBytes = 0;
  for (const url of urls) {
    const parsed = parseInputImageDataUrl(url, images.length + 1, totalBytes);
    images.push(parsed.image);
    totalBytes += parsed.decodedBytes;
  }
  return images;
}
