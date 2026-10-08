import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { ProtocolErrors } from '../../common/protocol-errors.decorator';
import {
  anthropicFileErrorResponse,
  requireAnthropicFilesBeta,
  toAnthropicFileObject,
} from './anthropic-file-resource';
import { parseFileHandle, type StoredFileRecord } from './file-store.types';
import { FilesService } from './files.service';
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
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ProtocolErrors((error, request) => clientFileErrorResponse(normalizeUploadError(error), request))
  async upload(@Req() request: FastifyRequest) {
    const dialect = resolveDialect(request);
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
    return this.toResource(dialect, record);
  }

  @Get()
  @ProtocolErrors(clientFileErrorResponse)
  async list(
    @Req() request: FastifyRequest,
    @Query('limit') limit?: string,
    @Query('after') after?: string,
  ) {
    const dialect = resolveDialect(request);
    this.enforceDialectGate(dialect, request);
    const page = await this.files.list(
      limit,
      after ? (parseFileHandle(after) ?? after) : undefined,
    );
    const data = page.files.map((record) => this.toResource(dialect, record));
    return dialect === 'openai'
      ? { object: 'list' as const, data, has_more: page.hasMore }
      : {
          data,
          has_more: page.hasMore,
          first_id: data.at(0)?.id ?? null,
          last_id: data.at(-1)?.id ?? null,
        };
  }

  @Get(':id')
  @ProtocolErrors(clientFileErrorResponse)
  async get(@Param('id') id: string, @Req() request: FastifyRequest) {
    const dialect = resolveDialect(request);
    this.enforceDialectGate(dialect, request);
    return this.toResource(dialect, await this.files.stat(id));
  }

  @Get(':id/content')
  async content(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const dialect = resolveDialect(request);
    try {
      this.enforceDialectGate(dialect, request);
      const { record, bytes } = await this.files.content(id);
      res.header('Content-Type', record.mimeType);
      res.header('Content-Length', String(record.sizeBytes));
      res.status(HttpStatus.OK).send(bytes);
    } catch (error) {
      const response = clientFileErrorResponse(error, request);
      res.status(response.statusCode).send(response.body);
    }
  }

  @Delete(':id')
  @ProtocolErrors(clientFileErrorResponse)
  async remove(@Param('id') id: string, @Req() request: FastifyRequest) {
    const dialect = resolveDialect(request);
    this.enforceDialectGate(dialect, request);
    const handle = await this.files.remove(id);
    return dialect === 'openai'
      ? { id: `file-${handle}`, object: 'file' as const, deleted: true }
      : { id: `file_${handle}`, type: 'file_deleted' as const };
  }

  private enforceDialectGate(dialect: FilesDialect, request: FastifyRequest): void {
    if (dialect === 'anthropic') {
      requireAnthropicFilesBeta(readHeader(request, 'anthropic-beta'));
    }
  }

  private toResource(dialect: FilesDialect, record: StoredFileRecord): { id: string } {
    return dialect === 'openai' ? toOpenAIFileObject(record) : toAnthropicFileObject(record);
  }
}

function clientFileErrorResponse(error: unknown, request: FastifyRequest) {
  return resolveDialect(request) === 'openai'
    ? openAIFileErrorResponse(error)
    : anthropicFileErrorResponse(error);
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
