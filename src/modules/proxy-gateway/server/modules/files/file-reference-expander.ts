import { isPlainObject, isString } from 'lodash-es';

import { FileStoreError, parseFileHandle, type StoredFileRecord } from './file-store.types';

/**
 * The single place where a stored file handle becomes request content.
 *
 * Every surface funnels through here so there is exactly one resolution
 * routine: one store, one expander, thin protocol adapters. The expansion is
 * always to inline bytes, because the upstream provider has no file plane —
 * `inlineData` (and the per-protocol shapes that map onto it) is the only way
 * these bytes can reach a model.
 *
 * Fail-closed: a handle this proxy never issued, or one that has expired, is an
 * error. It is never dropped, never forwarded upstream as an opaque URI, and
 * never silently replaced with an empty part.
 */

export type FileReferenceSurface = 'gemini' | 'openai-chat' | 'openai-responses' | 'anthropic';

export interface FileReferenceReader {
  get(id: string): Promise<{ record: StoredFileRecord; bytes: Buffer }>;
}

/** A reference the request named that this proxy cannot resolve. */
export class FileReferenceError extends Error {
  public readonly httpStatus: number;
  public readonly param: string;

  constructor(message: string, param: string, httpStatus = 400) {
    super(message);
    this.name = 'FileReferenceError';
    this.param = param;
    this.httpStatus = httpStatus;
  }
}

interface ResolvedFile {
  record: StoredFileRecord;
  dataUrl: string;
  base64: string;
}

export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/**
 * Rewrites every file reference in `body` into inline content.
 *
 * Returns the original object when the request names no handle, so the common
 * request path pays one walk and no copy.
 */
export async function expandFileReferences<T>(
  body: T,
  surface: FileReferenceSurface,
  store: FileReferenceReader | undefined,
): Promise<T> {
  if (!containsFileReference(body, surface)) {
    return body;
  }
  const cache = new Map<string, Promise<ResolvedFile>>();
  const resolve = (handle: string, param: string): Promise<ResolvedFile> =>
    resolveHandle(handle, param, store, cache);
  return (await transform(body, surface, resolve, 'body')) as T;
}

/**
 * Cheap pre-scan so ordinary requests are not deep-copied. Mirrors the shapes
 * {@link transform} rewrites; a false positive only costs the walk.
 */
function containsFileReference(value: unknown, surface: FileReferenceSurface): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsFileReference(entry, surface));
  }
  if (!isPlainObject(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (matchReference(record, surface)) {
    return true;
  }
  return Object.values(record).some((entry) => containsFileReference(entry, surface));
}

async function transform(
  value: unknown,
  surface: FileReferenceSurface,
  resolve: (handle: string, param: string) => Promise<ResolvedFile>,
  param: string,
): Promise<unknown> {
  if (Array.isArray(value)) {
    const mapped = await Promise.all(
      value.map((entry, index) => transform(entry, surface, resolve, `${param}.${index}`)),
    );
    return mapped.some((entry, index) => entry !== value[index]) ? mapped : value;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const reference = matchReference(record, surface);
  if (reference) {
    const resolved = await resolve(reference.handle, param);
    return reference.rewrite(record, resolved, param);
  }

  let changed = false;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const mapped = await transform(entry, surface, resolve, `${param}.${key}`);
    changed = changed || mapped !== entry;
    output[key] = mapped;
  }
  return changed ? output : value;
}

interface ReferenceMatch {
  handle: string;
  rewrite: (
    record: Record<string, unknown>,
    resolved: ResolvedFile,
    param: string,
  ) => Record<string, unknown>;
}

function matchReference(
  record: Record<string, unknown>,
  surface: FileReferenceSurface,
): ReferenceMatch | null {
  if (surface === 'gemini') {
    return matchGeminiFileData(record);
  }
  if (surface === 'anthropic') {
    return matchAnthropicFileSource(record);
  }
  if (surface === 'openai-chat') {
    return matchOpenAIChatFilePart(record);
  }
  return matchOpenAIResponsesFilePart(record);
}

/** `{ fileData: { fileUri, mimeType? } }` -> `{ inlineData: { mimeType, data } }`. */
function matchGeminiFileData(record: Record<string, unknown>): ReferenceMatch | null {
  const fileData = record.fileData;
  if (!isPlainObject(fileData)) {
    return null;
  }
  const fileUri = (fileData as Record<string, unknown>).fileUri;
  if (!isString(fileUri)) {
    return null;
  }
  return {
    handle: fileUri,
    rewrite: (part, resolved) => {
      const { fileData: _dropped, ...rest } = part;
      return {
        ...rest,
        inlineData: { mimeType: resolved.record.mimeType, data: resolved.base64 },
      };
    },
  };
}

/**
 * `{ type: 'image' | 'document', source: { type: 'file', file_id } }` ->
 * the same block with a base64 source, which the Claude mapper already turns
 * into `inlineData`.
 */
function matchAnthropicFileSource(record: Record<string, unknown>): ReferenceMatch | null {
  const type = record.type;
  if (type !== 'image' && type !== 'document') {
    return null;
  }
  const source = record.source;
  if (!isPlainObject(source)) {
    return null;
  }
  const sourceRecord = source as Record<string, unknown>;
  if (sourceRecord.type !== 'file' || !isString(sourceRecord.file_id)) {
    return null;
  }
  return {
    handle: sourceRecord.file_id,
    rewrite: (block, resolved) => ({
      ...block,
      source: {
        type: 'base64',
        media_type: resolved.record.mimeType,
        data: resolved.base64,
      },
    }),
  };
}

/** `{ type: 'file', file: { file_id } }` on Chat Completions content parts. */
function matchOpenAIChatFilePart(record: Record<string, unknown>): ReferenceMatch | null {
  if (record.type !== 'file' || !isPlainObject(record.file)) {
    return null;
  }
  const file = record.file as Record<string, unknown>;
  if (!isString(file.file_id)) {
    return null;
  }
  return {
    handle: file.file_id,
    rewrite: (part, resolved) =>
      isImageMimeType(resolved.record.mimeType)
        ? { type: 'image_url', image_url: { url: resolved.dataUrl } }
        : {
            type: 'file',
            file: {
              file_data: resolved.dataUrl,
              filename: resolved.record.displayName,
            },
          },
  };
}

/** `input_image` / `input_file` by `file_id` on the Responses surface. */
function matchOpenAIResponsesFilePart(record: Record<string, unknown>): ReferenceMatch | null {
  const type = record.type;
  if (type !== 'input_image' && type !== 'input_file') {
    return null;
  }
  if (!isString(record.file_id)) {
    return null;
  }
  return {
    handle: record.file_id,
    rewrite: (part, resolved, param) => {
      if (type === 'input_image' && !isImageMimeType(resolved.record.mimeType)) {
        throw new FileReferenceError(
          `${param} references ${resolved.record.mimeType} content, which cannot be sent as an input_image`,
          param,
        );
      }
      return isImageMimeType(resolved.record.mimeType)
        ? { type: 'input_image', image_url: resolved.dataUrl }
        : {
            type: 'input_file',
            file_data: resolved.dataUrl,
            filename: resolved.record.displayName,
          };
    },
  };
}

function resolveHandle(
  handle: string,
  param: string,
  store: FileReferenceReader | undefined,
  cache: Map<string, Promise<ResolvedFile>>,
): Promise<ResolvedFile> {
  const cached = cache.get(handle);
  if (cached) {
    return cached;
  }

  if (!store) {
    // Fail closed. Without a store there is nothing to resolve against, and a
    // reference forwarded upstream would fail as an unexplained provider error.
    return Promise.reject(
      new FileReferenceError(
        `${param} references '${handle}', but the file store is not available on this proxy`,
        param,
        404,
      ),
    );
  }

  const id = parseFileHandle(handle);
  const pending = (
    id
      ? store.get(id)
      : Promise.reject(
          new FileReferenceError(
            `${param} references '${handle}', which is not a file handle issued by this proxy`,
            param,
            404,
          ),
        )
  ).then(
    ({ record, bytes }) => {
      const base64 = bytes.toString('base64');
      return {
        record,
        base64,
        dataUrl: `data:${record.mimeType};base64,${base64}`,
      } satisfies ResolvedFile;
    },
    (error: unknown) => {
      if (error instanceof FileStoreError) {
        throw new FileReferenceError(
          `${param} references '${handle}': ${error.message}`,
          param,
          error.httpStatus === 400 ? 404 : error.httpStatus,
        );
      }
      throw error;
    },
  );

  cache.set(handle, pending);
  return pending;
}
