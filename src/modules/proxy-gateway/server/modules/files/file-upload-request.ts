import type { FastifyRequest } from 'fastify';

import { DEFAULT_MAX_FILE_BYTES, FileStoreError } from './file-store.types';

/**
 * Multipart and raw-media parsing shared by all three file upload surfaces.
 *
 * Deliberately protocol-agnostic: it hands back bytes plus whatever metadata
 * the transport carried, and every dialect-specific rule (OpenAI `purpose`,
 * Gemini's `metadata` JSON part, Anthropic's beta gate) lives in the adapter
 * that owns it.
 */

export interface ParsedFileUpload {
  bytes: Buffer;
  /** Non-file multipart fields, e.g. OpenAI's `purpose`. */
  fields: Record<string, string>;
  filename?: string;
  mimeType?: string;
}

export const FILE_UPLOAD_MULTIPART_LIMITS = {
  fieldNameSize: 100,
  fieldSize: 64 * 1024,
  fields: 8,
  fileSize: DEFAULT_MAX_FILE_BYTES,
  files: 1,
  headerPairs: 256,
  parts: 12,
} as const;

export class FileUploadError extends Error {
  public readonly httpStatus: number;
  public readonly param: string;

  constructor(message: string, param: string, httpStatus = 400) {
    super(message);
    this.name = 'FileUploadError';
    this.param = param;
    this.httpStatus = httpStatus;
  }
}

function hasMultipartBoundary(request: FastifyRequest): boolean {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string') {
    return false;
  }
  const lowered = contentType.toLowerCase();
  return lowered.includes('multipart/form-data') && lowered.includes('boundary=');
}

/**
 * Reads either a `multipart/form-data` upload or a raw media body.
 *
 * The raw form is what Google's "simple" upload uses: the whole request body is
 * the file and `Content-Type` names its type. Fastify hands that to us as a
 * Buffer through the media content-type parser registered at boot.
 */
export async function parseFileUploadRequest(
  request: FastifyRequest,
  options: { allowRawBody?: boolean } = {},
): Promise<ParsedFileUpload> {
  if (hasMultipartBoundary(request)) {
    return parseMultipartUpload(request);
  }
  if (options.allowRawBody !== false) {
    return parseRawUpload(request);
  }
  throw new FileUploadError(
    'Expected a multipart/form-data request with a valid boundary',
    'content-type',
  );
}

async function parseMultipartUpload(request: FastifyRequest): Promise<ParsedFileUpload> {
  const fields: Record<string, string> = {};
  let upload: ParsedFileUpload | undefined;

  try {
    for await (const part of request.parts({ limits: FILE_UPLOAD_MULTIPART_LIMITS })) {
      if (part.type === 'file') {
        if (upload) {
          part.file.resume();
          throw new FileUploadError('Only one file may be uploaded per request', 'file');
        }
        const bytes = await part.toBuffer();
        if (part.file.truncated) {
          throw new FileUploadError(
            `Uploaded file exceeds the ${FILE_UPLOAD_MULTIPART_LIMITS.fileSize} byte limit`,
            'file',
            413,
          );
        }
        upload = {
          bytes,
          fields,
          ...(part.filename ? { filename: part.filename } : {}),
          ...(part.mimetype ? { mimeType: part.mimetype } : {}),
        };
        continue;
      }

      if (part.valueTruncated) {
        throw new FileUploadError(`${part.fieldname} exceeds the field limit`, part.fieldname, 413);
      }
      fields[part.fieldname] = String(part.value ?? '');
    }
  } catch (error) {
    throw normalizeUploadError(error);
  }

  if (!upload) {
    throw new FileUploadError('A file part is required', 'file');
  }
  return { ...upload, fields };
}

function parseRawUpload(request: FastifyRequest): ParsedFileUpload {
  const body = request.body;
  const bytes = Buffer.isBuffer(body)
    ? body
    : typeof body === 'string'
      ? Buffer.from(body, 'utf8')
      : undefined;
  if (!bytes) {
    throw new FileUploadError(
      'Expected the request body to be the file content, or a multipart/form-data upload',
      'body',
    );
  }
  const contentType = request.headers['content-type'];
  return {
    bytes,
    fields: {},
    ...(typeof contentType === 'string' ? { mimeType: contentType } : {}),
  };
}

/**
 * Maps the transport's own size failures onto the same 413 the store raises,
 * so a client sees one consistent answer whichever ceiling it hit first.
 */
export function normalizeUploadError(error: unknown): unknown {
  if (error instanceof FileUploadError || error instanceof FileStoreError) {
    return error;
  }
  const code = (error as { code?: unknown })?.code;
  if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return new FileUploadError(
      `Uploaded file exceeds the ${FILE_UPLOAD_MULTIPART_LIMITS.fileSize} byte limit`,
      'file',
      413,
    );
  }
  if (code === 'FST_PARTS_LIMIT' || code === 'FST_FILES_LIMIT') {
    return new FileUploadError('Only one file may be uploaded per request', 'file');
  }
  return error;
}
