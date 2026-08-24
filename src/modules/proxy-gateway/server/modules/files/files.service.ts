import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { forEach } from 'lodash-es';

import { FileContentStore } from './file-content-store.service';
import {
  FileStoreError,
  parseFileHandle,
  type PutFileInput,
  type StoredFileRecord,
} from './file-store.types';

export interface FilesErrorResponse {
  statusCode: number;
  body: unknown;
}

interface FilesReply<TBody> {
  body: TBody;
  headers?: Record<string, string>;
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

/** Applies one Files operation to a Fastify reply without owning protocol envelopes. */
export async function sendFilesResponse<TBody>(
  res: FastifyReply,
  operation: () => Promise<FilesReply<TBody>>,
  toErrorResponse: (error: unknown) => FilesErrorResponse,
  normalizeError?: (error: unknown) => unknown,
): Promise<void> {
  try {
    const response = await operation();
    if (response.headers) {
      forEach(response.headers, (value, name) => {
        res.header(name, value);
      });
    }
    res.status(HttpStatus.OK).send(response.body);
  } catch (error) {
    const response = toErrorResponse(normalizeError ? normalizeError(error) : error);
    res.status(response.statusCode).send(response.body);
  }
}
