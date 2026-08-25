import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { forEach } from 'lodash-es';

import { FilesService } from '../files/files.service';
import { parseFileHandle } from '../files/file-store.types';
import { OPENAI_FILE_ID_PREFIX } from '../files/openai-file-resource';
import { buildOpenAIOutputFiles } from './openai-batch-resource';
import { BatchRunnerService, type CreateBatchInput } from './batch-runner.service';
import {
  BatchJobError,
  parseBatchHandle,
  type BatchDialect,
  type BatchJobRecord,
} from './batch-job.types';

export interface BatchPage {
  jobs: BatchJobRecord[];
  hasMore: boolean;
}

export interface BatchErrorResponse {
  statusCode: number;
  body: unknown;
}

interface BatchReply<TBody> {
  body: TBody;
  headers?: Record<string, string>;
}

/** Shared job operations and cursor policies for the three Batch HTTP adapters. */
@Injectable()
export class BatchService {
  constructor(
    @Inject(BatchRunnerService) private readonly runner: BatchRunnerService,
    @Optional() @Inject(FilesService) private readonly files?: FilesService,
  ) {
    this.runner.registerFinalizer('openai', (job) => this.writeOpenAIOutputFiles(job));
  }

  public create(input: CreateBatchInput): BatchJobRecord {
    return this.runner.create(input);
  }

  public get(dialect: BatchDialect, id: string): BatchJobRecord {
    const handle = parseBatchHandle(id);
    if (!handle) {
      throw BatchJobError.notFound(id);
    }
    const job = this.runner.require(handle);
    if (job.dialect !== dialect) {
      throw BatchJobError.notFound(id);
    }
    return job;
  }

  public cancel(dialect: BatchDialect, id: string): BatchJobRecord {
    return this.runner.cancel(this.get(dialect, id).id);
  }

  public remove(job: BatchJobRecord): boolean {
    return this.runner.delete(job.id);
  }

  public listOpenAI(limit?: string, after?: string): BatchPage {
    const all = this.runner.list('openai');
    const offset = this.resolveOpenAIOffset(all, after);
    if (offset === null) {
      return { jobs: [], hasMore: false };
    }
    const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const jobs = all.slice(offset, offset + size);
    return { jobs, hasMore: all.length > offset + jobs.length };
  }

  public listAnthropic(limit?: string, afterId?: string, beforeId?: string): BatchPage {
    if (afterId && beforeId) {
      throw BatchJobError.invalid('only one of after_id or before_id may be provided', 'after_id');
    }
    const size = this.requireAnthropicLimit(limit);
    const all = this.runner.list('anthropic');
    if (afterId) {
      const index = this.requireCursorIndex(all, afterId);
      const jobs = all.slice(index + 1, index + 1 + size);
      return { jobs, hasMore: all.length > index + 1 + jobs.length };
    }
    if (beforeId) {
      const index = this.requireCursorIndex(all, beforeId);
      const start = Math.max(0, index - size);
      return { jobs: all.slice(start, index), hasMore: start > 0 };
    }
    const jobs = all.slice(0, size);
    return { jobs, hasMore: all.length > jobs.length };
  }

  public listGemini(pageSize?: string, pageToken?: string): BatchPage {
    const all = this.runner.list('gemini');
    const startId = pageToken ? parseBatchHandle(pageToken) : null;
    if (pageToken && !startId) {
      throw BatchJobError.invalid(`pageToken '${pageToken}' is not a batch this proxy issued`);
    }
    const offset = startId ? all.findIndex((job) => job.id === startId) + 1 : 0;
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 100);
    const jobs = all.slice(offset, offset + size);
    return { jobs, hasMore: all.length > offset + jobs.length };
  }

  public async readOpenAIInput(inputFileId: string): Promise<string> {
    if (!this.files) {
      throw new BatchJobError(
        'store_unavailable',
        'The local file store is not available, so no input file can be read',
        503,
      );
    }
    if (!parseFileHandle(inputFileId)) {
      throw BatchJobError.invalid(
        `input_file_id '${inputFileId}' was never issued by this proxy`,
        'input_file_id',
      );
    }
    const { bytes } = await this.files.content(inputFileId);
    return bytes.toString('utf-8');
  }

  private resolveOpenAIOffset(all: BatchJobRecord[], after?: string): number | null {
    if (!after) {
      return 0;
    }
    const startId = parseBatchHandle(after);
    const index = startId ? all.findIndex((job) => job.id === startId) : -1;
    return index === -1 ? null : index + 1;
  }

  private requireAnthropicLimit(limit?: string): number {
    if (limit === undefined || limit === '') {
      return 20;
    }
    const value = Number(limit);
    if (!Number.isInteger(value) || value < 1 || value > 1000) {
      throw BatchJobError.invalid(
        `limit must be an integer between 1 and 1000; got '${limit}'`,
        'limit',
      );
    }
    return value;
  }

  private requireCursorIndex(all: BatchJobRecord[], cursor: string): number {
    const startId = parseBatchHandle(cursor);
    const index = startId ? all.findIndex((job) => job.id === startId) : -1;
    if (index === -1) {
      throw BatchJobError.notFound(cursor);
    }
    return index;
  }

  private async writeOpenAIOutputFiles(job: BatchJobRecord): Promise<Partial<BatchJobRecord>> {
    if (!this.files) {
      return {};
    }
    const { output, errors } = buildOpenAIOutputFiles(job);
    const patch: Partial<BatchJobRecord> = {};
    if (output) {
      patch.outputFileId = await this.storeOpenAIJsonl(job.id, 'output', output);
    }
    if (errors) {
      patch.errorFileId = await this.storeOpenAIJsonl(job.id, 'error', errors);
    }
    return patch;
  }

  private async storeOpenAIJsonl(
    batchId: string,
    kind: 'error' | 'output',
    content: string,
  ): Promise<string> {
    const record = await this.files!.create({
      bytes: Buffer.from(content, 'utf-8'),
      declaredMimeType: 'application/jsonl',
      displayName: `batch_${batchId}_${kind}.jsonl`,
      purpose: 'batch_output',
    });
    return `${OPENAI_FILE_ID_PREFIX}${record.id}`;
  }
}

function applyBatchReply<TBody>(res: FastifyReply, response: BatchReply<TBody>): void {
  if (response.headers) {
    forEach(response.headers, (value, name) => {
      res.header(name, value);
    });
  }
  res.status(HttpStatus.OK).send(response.body);
}

function applyBatchError(
  res: FastifyReply,
  error: unknown,
  toErrorResponse: (error: unknown) => BatchErrorResponse,
): void {
  const response = toErrorResponse(error);
  res.status(response.statusCode).send(response.body);
}

export function sendBatchResponse<TBody>(
  res: FastifyReply,
  operation: () => BatchReply<TBody>,
  toErrorResponse: (error: unknown) => BatchErrorResponse,
): void {
  try {
    applyBatchReply(res, operation());
  } catch (error) {
    applyBatchError(res, error, toErrorResponse);
  }
}

export async function sendAsyncBatchResponse<TBody>(
  res: FastifyReply,
  operation: () => Promise<BatchReply<TBody>>,
  toErrorResponse: (error: unknown) => BatchErrorResponse,
): Promise<void> {
  try {
    applyBatchReply(res, await operation());
  } catch (error) {
    applyBatchError(res, error, toErrorResponse);
  }
}
