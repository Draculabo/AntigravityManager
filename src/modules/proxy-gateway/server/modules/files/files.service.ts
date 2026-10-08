import { Inject, Injectable } from '@nestjs/common';

import { FileContentStore } from './file-content-store.service';
import {
  FileStoreError,
  parseFileHandle,
  type PutFileInput,
  type StoredFileRecord,
} from './file-store.types';

export interface FilesPage {
  files: StoredFileRecord[];
  hasMore: boolean;
  nextPageToken?: string;
}

/** Shared file operations for HTTP adapters and dependent Batch/Uploads modules. */
@Injectable()
export class FilesService {
  constructor(@Inject(FileContentStore) private readonly store: FileContentStore) {}

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
