import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Optional,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { FileContentStore } from '../files/file-content-store.service';
import { parseFileHandle } from '../files/file-store.types';
import { OPENAI_FILE_ID_PREFIX } from '../files/openai-file-resource';
import { BatchRunnerService } from './batch-runner.service';
import { BatchJobError, parseBatchHandle, type BatchJobRecord } from './batch-job.types';
import {
  buildOpenAIOutputFiles,
  normalizeBatchMetadata,
  openAIBatchErrorResponse,
  parseBatchInputJsonl,
  requireCompletionWindow,
  requireServableEndpoint,
  toOpenAIBatchObject,
} from './openai-batch-resource';

/**
 * OpenAI `/v1/batches`, served by the proxy's own local deferred-job runner.
 *
 * There is no provider batch plane behind this: the requests are the same
 * `generateContent` calls the interactive endpoints make, run later and
 * slower through {@link BatchRunnerService}. No discount, no separate quota,
 * no separate rate limit.
 *
 * Input and output are JSONL through the local Files API: the input file is
 * read from {@link FileContentStore} by `input_file_id`, and the output and
 * error files are written back into it and referenced as `output_file_id` /
 * `error_file_id`. A client id string is only ever matched against
 * `parseFileHandle`'s pattern -- it never reaches the filesystem.
 */
@Controller('v1/batches')
@UseGuards(ProxyGuard)
export class OpenAIBatchesController {
  constructor(
    @Inject(BatchRunnerService) private readonly runner: BatchRunnerService,
    @Optional() @Inject(FileContentStore) private readonly files?: FileContentStore,
  ) {
    this.runner.registerFinalizer('openai', (job) => this.writeOutputFiles(job));
  }

  @Post()
  async create(@Body() body: Record<string, unknown>, @Res() res: FastifyReply): Promise<void> {
    try {
      const endpoint = requireServableEndpoint(body?.endpoint);
      const completionWindow = requireCompletionWindow(body?.completion_window);
      const metadata = normalizeBatchMetadata(body?.metadata);
      const inputFileId = requireString(body?.input_file_id, 'input_file_id');
      const content = await this.readInputFile(inputFileId);
      const lines = parseBatchInputJsonl(content, endpoint);

      const job = this.runner.create({
        dialect: 'openai',
        endpoint,
        completionWindow,
        inputFileId,
        requests: lines,
        ...(metadata ? { metadata } : {}),
      });
      res.status(HttpStatus.OK).send(toOpenAIBatchObject(job));
    } catch (error) {
      this.sendError(res, error);
    }
  }

  @Get()
  list(@Res() res: FastifyReply, @Query('limit') limit?: string, @Query('after') after?: string) {
    try {
      const all = this.runner.list('openai');
      const startId = after ? parseBatchHandle(after) : null;
      const offset = startId ? all.findIndex((job) => job.id === startId) + 1 : 0;
      const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
      const page = all.slice(offset, offset + size);
      const data = page.map((job) => toOpenAIBatchObject(job));
      res.status(HttpStatus.OK).send({
        object: 'list',
        data,
        first_id: data.at(0)?.id ?? null,
        last_id: data.at(-1)?.id ?? null,
        has_more: all.length > offset + page.length,
      });
    } catch (error) {
      this.sendError(res, error);
    }
  }

  @Get(':id')
  get(@Param('id') id: string, @Res() res: FastifyReply) {
    try {
      const job = this.requireJob(id);
      res.status(HttpStatus.OK).send(toOpenAIBatchObject(job));
    } catch (error) {
      this.sendError(res, error);
    }
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Res() res: FastifyReply) {
    try {
      const job = this.runner.cancel(this.requireJob(id).id);
      res.status(HttpStatus.OK).send(toOpenAIBatchObject(job));
    } catch (error) {
      this.sendError(res, error);
    }
  }

  /**
   * Writes the result JSONL back into the local file store once the batch has
   * stopped running, so the client fetches them with the same
   * `GET /v1/files/{id}/content` it already uses for anything else it
   * uploaded.
   */
  private async writeOutputFiles(job: BatchJobRecord): Promise<Partial<BatchJobRecord>> {
    if (!this.files) {
      return {};
    }
    const { output, errors } = buildOpenAIOutputFiles(job);
    const patch: Partial<BatchJobRecord> = {};
    if (output) {
      patch.outputFileId = await this.storeJsonl(job.id, 'output', output);
    }
    if (errors) {
      patch.errorFileId = await this.storeJsonl(job.id, 'error', errors);
    }
    return patch;
  }

  private async storeJsonl(batchId: string, kind: string, content: string): Promise<string> {
    const record = await this.files!.put({
      bytes: Buffer.from(content, 'utf-8'),
      declaredMimeType: 'application/jsonl',
      displayName: `batch_${batchId}_${kind}.jsonl`,
      purpose: 'batch_output',
    });
    return `${OPENAI_FILE_ID_PREFIX}${record.id}`;
  }

  private async readInputFile(inputFileId: string): Promise<string> {
    if (!this.files) {
      throw new BatchJobError(
        'store_unavailable',
        'The local file store is not available, so no input file can be read',
        503,
      );
    }
    const handle = parseFileHandle(inputFileId);
    if (!handle) {
      throw BatchJobError.invalid(
        `input_file_id '${inputFileId}' was never issued by this proxy`,
        'input_file_id',
      );
    }
    const { bytes } = await this.files.get(handle);
    return bytes.toString('utf-8');
  }

  private requireJob(id: string): BatchJobRecord {
    const handle = parseBatchHandle(id);
    if (!handle) {
      throw BatchJobError.notFound(id);
    }
    const job = this.runner.require(handle);
    if (job.dialect !== 'openai') {
      throw BatchJobError.notFound(id);
    }
    return job;
  }

  private sendError(res: FastifyReply, error: unknown): void {
    const { statusCode, body } = openAIBatchErrorResponse(error);
    res.status(statusCode).send(body);
  }
}

function requireString(value: unknown, param: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw BatchJobError.invalid(`${param} is required`, param);
  }
  return value.trim();
}
