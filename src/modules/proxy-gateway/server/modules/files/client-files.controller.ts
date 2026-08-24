import {
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { LocalResourceErrorResponse } from '../../common/local-resource/local-resource-controller.kernel';
import { ProxyGuard } from '../../guards/proxy.guard';
import {
  anthropicFileErrorResponse,
  requireAnthropicFilesBeta,
  toAnthropicFileObject,
} from './anthropic-file-resource';
import { FileResourceKernel } from './file-resource.kernel';
import { parseFileHandle, type StoredFileRecord } from './file-store.types';
import {
  normalizeOpenAIPurpose,
  openAIFileErrorResponse,
  toOpenAIFileObject,
} from './openai-file-resource';
import { normalizeUploadError, parseFileUploadRequest } from './file-upload-request';

type FilesDialect = 'anthropic' | 'openai';

/** OpenAI and Anthropic route adapter for the shared local Files capability. */
@Controller('v1/files')
@UseGuards(ProxyGuard)
export class ClientFilesController {
  constructor(@Inject(FileResourceKernel) private readonly files: FileResourceKernel) {}

  @Post()
  async upload(@Req() request: FastifyRequest, @Res() res: FastifyReply): Promise<void> {
    const dialect = resolveDialect(request);
    await this.files.respond(
      res,
      async () => {
        this.enforceDialectGate(dialect, request);
        const upload = await parseFileUploadRequest(request, { allowRawBody: false });
        const purpose =
          dialect === 'openai' ? normalizeOpenAIPurpose(upload.fields.purpose) : undefined;
        const record = await this.files.create({
          bytes: upload.bytes,
          declaredMimeType: upload.mimeType,
          displayName: upload.filename,
          purpose,
        });
        return { body: this.toResource(dialect, record) };
      },
      (error) => this.toErrorResponse(dialect, error),
      normalizeUploadError,
    );
  }

  @Get()
  async list(
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
    @Query('limit') limit?: string,
    @Query('after') after?: string,
  ): Promise<void> {
    const dialect = resolveDialect(request);
    await this.files.respond(
      res,
      async () => {
        this.enforceDialectGate(dialect, request);
        const page = await this.files.list(
          limit,
          after ? (parseFileHandle(after) ?? after) : undefined,
        );
        const data = page.resources.map((record) => this.toResource(dialect, record));
        return {
          body:
            dialect === 'openai'
              ? { object: 'list' as const, data, has_more: page.hasMore }
              : {
                  data,
                  has_more: page.hasMore,
                  first_id: data.at(0)?.id ?? null,
                  last_id: data.at(-1)?.id ?? null,
                },
        };
      },
      (error) => this.toErrorResponse(dialect, error),
    );
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const dialect = resolveDialect(request);
    await this.files.respond(
      res,
      async () => {
        this.enforceDialectGate(dialect, request);
        return { body: this.toResource(dialect, await this.files.stat(id)) };
      },
      (error) => this.toErrorResponse(dialect, error),
    );
  }

  @Get(':id/content')
  async content(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const dialect = resolveDialect(request);
    await this.files.respond(
      res,
      async () => {
        this.enforceDialectGate(dialect, request);
        const { resource, content } = await this.files.content(id);
        return {
          body: content,
          headers: {
            'Content-Type': resource.mimeType,
            'Content-Length': String(resource.sizeBytes),
          },
        };
      },
      (error) => this.toErrorResponse(dialect, error),
    );
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const dialect = resolveDialect(request);
    await this.files.respond(
      res,
      async () => {
        this.enforceDialectGate(dialect, request);
        const handle = await this.files.remove(id);
        return {
          body:
            dialect === 'openai'
              ? { id: `file-${handle}`, object: 'file' as const, deleted: true }
              : { id: `file_${handle}`, type: 'file_deleted' as const },
        };
      },
      (error) => this.toErrorResponse(dialect, error),
    );
  }

  private enforceDialectGate(dialect: FilesDialect, request: FastifyRequest): void {
    if (dialect === 'anthropic') {
      requireAnthropicFilesBeta(readHeader(request, 'anthropic-beta'));
    }
  }

  private toResource(dialect: FilesDialect, record: StoredFileRecord): { id: string } {
    return dialect === 'openai' ? toOpenAIFileObject(record) : toAnthropicFileObject(record);
  }

  private toErrorResponse(dialect: FilesDialect, error: unknown): LocalResourceErrorResponse {
    return dialect === 'openai'
      ? openAIFileErrorResponse(error)
      : anthropicFileErrorResponse(error);
  }
}

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}

function resolveDialect(request: FastifyRequest): FilesDialect {
  return readHeader(request, 'anthropic-version') || readHeader(request, 'anthropic-beta')
    ? 'anthropic'
    : 'openai';
}
