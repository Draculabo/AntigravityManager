const MAX_LOGGED_FIELD_CHARACTERS = 500;

export interface ImageMonitoringInput {
  data?: string;
  filename?: string;
  mimeType?: string;
}

export interface ImageMonitoringRequest {
  model?: string;
  prompt?: string;
  size?: string;
  quality?: string;
  image?: string | ImageMonitoringInput;
  mask?: string | ImageMonitoringInput;
  reference_images?: Array<string | ImageMonitoringInput>;
}

interface ImageFileSummary {
  field: string;
  filename?: string;
  content_type: string;
  bytes: number;
}

export interface ImageRequestMonitoringSummary {
  content_type: 'application/json' | 'multipart/form-data';
  path: string;
  fields: {
    model?: string;
    prompt?: string;
    quality?: string;
    size?: string;
  };
  files: ImageFileSummary[];
  raw_bytes: number;
}

interface ImageDimensions {
  width: number;
  height: number;
}

interface ImageResponseItem {
  b64_json?: string;
  revised_prompt?: string;
  url?: string;
}

export interface OpenAIImageResponse {
  created: number;
  data: ImageResponseItem[];
}

interface ImageResponseMonitoringItem {
  revised_prompt?: string;
  url?: string;
  image?: {
    encoding: 'base64';
    redacted: true;
    mime_type: string;
    bytes: number;
    dimensions?: ImageDimensions;
  };
}

export interface ImageResponseMonitoringSummary {
  created: number;
  data: ImageResponseMonitoringItem[];
}

function truncateForLog(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= MAX_LOGGED_FIELD_CHARACTERS) {
    return value;
  }
  return `${characters.slice(0, MAX_LOGGED_FIELD_CHARACTERS).join('')}...`;
}

function estimateBase64Bytes(encoded: string): number {
  const normalized = encoded.replace(/\s/gu, '');
  if (!normalized) {
    return 0;
  }
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function parseImageInput(
  field: string,
  input: string | ImageMonitoringInput,
): ImageFileSummary | null {
  const rawData = typeof input === 'string' ? input : input.data;
  if (!rawData) {
    return null;
  }

  const dataUrlMatch = /^data:(?<mime>[\w/+.-]+);base64,(?<data>[\s\S]+)$/u.exec(rawData);
  const encodedData = dataUrlMatch?.groups?.data ?? rawData;
  return {
    field,
    filename: typeof input === 'string' ? undefined : input.filename,
    content_type:
      dataUrlMatch?.groups?.mime ||
      (typeof input === 'string' ? undefined : input.mimeType) ||
      'application/octet-stream',
    bytes: estimateBase64Bytes(encodedData),
  };
}

function collectFileSummaries(body: ImageMonitoringRequest): ImageFileSummary[] {
  const files: ImageFileSummary[] = [];
  const addFile = (field: string, input: string | ImageMonitoringInput | undefined) => {
    if (!input) {
      return;
    }
    const summary = parseImageInput(field, input);
    if (summary) {
      files.push(summary);
    }
  };

  addFile('image', body.image);
  addFile('mask', body.mask);
  for (const referenceImage of body.reference_images ?? []) {
    addFile('reference_images', referenceImage);
  }
  return files;
}

export function summarizeImageRequest(
  path: string,
  body: ImageMonitoringRequest,
): ImageRequestMonitoringSummary {
  const files = collectFileSummaries(body);
  const fields = {
    model: body.model ? truncateForLog(body.model) : undefined,
    prompt: body.prompt ? truncateForLog(body.prompt) : undefined,
    quality: body.quality ? truncateForLog(body.quality) : undefined,
    size: body.size ? truncateForLog(body.size) : undefined,
  };
  const fieldBytes = [body.model, body.prompt, body.quality, body.size].reduce(
    (total, value) => total + (value ? Buffer.byteLength(value, 'utf8') : 0),
    0,
  );

  return {
    content_type: files.length > 0 ? 'multipart/form-data' : 'application/json',
    path,
    fields,
    files,
    raw_bytes: fieldBytes + files.reduce((total, file) => total + file.bytes, 0),
  };
}

function readJpegDimensions(bytes: Buffer): ImageDimensions | undefined {
  let index = 2;
  while (index + 9 < bytes.length) {
    if (bytes[index] !== 0xff) {
      index += 1;
      continue;
    }

    const marker = bytes[index + 1];
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    const segmentLength = bytes.readUInt16BE(index + 2);
    if (segmentLength < 2 || index + 2 + segmentLength > bytes.length) {
      break;
    }
    const isStartOfFrame = [
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
    ].includes(marker);
    if (isStartOfFrame && segmentLength >= 7) {
      return {
        height: bytes.readUInt16BE(index + 5),
        width: bytes.readUInt16BE(index + 7),
      };
    }
    index += 2 + segmentLength;
  }
  return undefined;
}

function inspectImage(encoded: string): {
  bytes: number;
  dimensions?: ImageDimensions;
  mimeType: string;
} {
  try {
    const bytes = Buffer.from(encoded, 'base64');
    if (
      bytes.length >= 24 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return {
        bytes: bytes.length,
        dimensions: {
          width: bytes.readUInt32BE(16),
          height: bytes.readUInt32BE(20),
        },
        mimeType: 'image/png',
      };
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      return {
        bytes: bytes.length,
        dimensions: readJpegDimensions(bytes),
        mimeType: 'image/jpeg',
      };
    }
    return {
      bytes: bytes.length,
      mimeType: 'application/octet-stream',
    };
  } catch {
    return {
      bytes: estimateBase64Bytes(encoded),
      mimeType: 'unknown',
    };
  }
}

export function summarizeImageResponse(
  response: OpenAIImageResponse,
): ImageResponseMonitoringSummary {
  return {
    created: response.created,
    data: response.data.map((item) => {
      if (item.b64_json) {
        const inspected = inspectImage(item.b64_json);
        return {
          revised_prompt: item.revised_prompt,
          image: {
            encoding: 'base64',
            redacted: true,
            mime_type: inspected.mimeType,
            bytes: inspected.bytes,
            dimensions: inspected.dimensions,
          },
        };
      }
      return {
        revised_prompt: item.revised_prompt,
        url: item.url?.startsWith('data:image/')
          ? `[data URL redacted: ${item.url.length} chars]`
          : item.url,
      };
    }),
  };
}
