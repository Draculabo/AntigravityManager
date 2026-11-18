import { Inject, Injectable } from '@nestjs/common';

import { FileContentStore } from './file-content-store.service';
import {
  DEFAULT_FILE_TTL_MS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_STORE_BYTES,
  FileStoreError,
  parseFileHandle,
  type FileStoreOptions,
  type PutFileInput,
  type StoredFileRecord,
} from './file-store.types';

export interface PrivateContentStoreOptions {
  rootDirectory: string;
  maxFileBytes?: number;
  maxStoreBytes?: number;
  ttlMs?: number;
}

/**
 * Private content storage for other gateway features.
 *
 * It exposes no client-facing handle operations. The caller owns the returned
 * namespace and must dispose it with its module lifecycle.
 */
export interface PrivateContentStore {
  dispose(): void;
  get(id: string): Promise<Buffer>;
  put(bytes: Buffer, declaredMimeType?: string): Promise<string>;
}

export interface FilesPage {
  files: StoredFileRecord[];
  hasMore: boolean;
  nextPageToken?: string;
}

/** Shared file operations for HTTP adapters and dependent Batch/Uploads modules. */
@Injectable()
export class FilesService {
  constructor(@Inject(FileContentStore) private readonly store: FileContentStore) {}

  public createPrivateContentStore(options: PrivateContentStoreOptions): PrivateContentStore {
    const privateStore = new FileContentStore({
      maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      maxStoreBytes: options.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES,
      propagateIndexWriteErrors: true,
      rootDirectory: options.rootDirectory,
      ttlMs: options.ttlMs ?? DEFAULT_FILE_TTL_MS,
    } satisfies FileStoreOptions);
    let pendingWrites = Promise.resolve();

    const enqueueWrite = <T>(write: () => Promise<T>): Promise<T> => {
      const result = pendingWrites.then(write);
      pendingWrites = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };

    return {
      dispose: () => privateStore.onModuleDestroy(),
      get: async (id) => {
        await pendingWrites;
        const { record, bytes } = await privateStore.get(id);
        await enqueueWrite(() =>
          privateStore.put({
            bytes,
            declaredMimeType: record.declaredMimeType,
            displayName: record.displayName,
            purpose: record.purpose,
          }),
        );
        return bytes;
      },
      put: (bytes, declaredMimeType) =>
        enqueueWrite(async () => (await privateStore.put({ bytes, declaredMimeType })).id),
    };
  }

  public getLimits(): ReturnType<FileContentStore['getLimits']> {
    return this.store.getLimits();
  }

  public create(input: PutFileInput): Promise<StoredFileRecord> {
    return this.store.put(input);
  }

  public async list(limit?: string, pageToken?: string): Promise<FilesPage> {
    const result = await this.store.list({
      limit: limit ? Number(limit) : undefined,
      pageToken,
    });
    return {
      files: result.files,
      hasMore: Boolean(result.nextPageToken),
      ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
    };
  }

  public stat(value: string): Promise<StoredFileRecord> {
    return this.store.stat(this.requireHandle(value));
  }

  public content(value: string): Promise<{ record: StoredFileRecord; bytes: Buffer }> {
    return this.store.get(this.requireHandle(value));
  }

  public async remove(value: string): Promise<string> {
    const handle = this.requireHandle(value);
    if (!(await this.store.delete(handle))) {
      throw FileStoreError.notFound(value);
    }
    return handle;
  }

  private requireHandle(value: string): string {
    const handle = parseFileHandle(value);
    if (!handle) {
      throw FileStoreError.notFound(value);
    }
    return handle;
  }
}
