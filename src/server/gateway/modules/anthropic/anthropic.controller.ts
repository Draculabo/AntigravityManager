import { getGenerationTimeoutMs } from '../../common/generation-timeout-policy';
import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Optional,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply, type FastifyRequest } from 'fastify';
import { AnthropicChatRequest } from '@/server/gateway/common/interfaces/request-interfaces';
import {
  BaseProxyController,
  createProxyRequestAbortScope,
} from '@/server/gateway/common/base-proxy.controller';
import { formatCountTokensReason } from '@/server/gateway/common/base-proxy.service';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { FilesService } from '@/server/gateway/modules/files/files.service';
import {
  expandFileReferences,
  FileReferenceError,
} from '@/server/gateway/modules/files/file-reference-expander';
import { AnthropicService } from './anthropic.service';
import { setProxyResponseTimingHeaders } from '../../common/proxy-response-timing';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import { getPublishedModelMapping } from '@/modules/config/model-aliases';
import { GenerationDeadlineScope } from '../../common/generation-deadline';
import { awaitRequestOperation } from '../../common/request-cancellation';
import { getServerConfig } from '@/server/server-config';
import { getAllDynamicModels } from '@/modules/proxy-gateway/antigravity/ModelMapping';
import { tryResolveModelDiscoveryMetadata } from '../../shared/services/model-discovery-metadata';
import {
  CoworkCompactionControl,
  isCoworkLocalAcknowledgement,
} from '../../common/cowork-compaction-control';

@Controller('v1')
@UseGuards(ProxyGuard)
export class AnthropicController extends BaseProxyController {
  constructor(
    @Inject(AnthropicService) private readonly proxyService: AnthropicService,
    @Optional() @Inject(FilesService) private readonly files?: FilesService,
    @Optional()
    @Inject(AccountLeaseService)
    private readonly accountLeaseService?: AccountLeaseService,
  ) {
    super();
  }

  @Get('models/claude')
  listClaudeModels() {
    const data = this.listClaudeModelIds().map((id) => this.toClaudeModelMetadata(id));
    return {
      data,
      first_id: data[0]?.id ?? null,
      has_more: false,
      last_id: data.at(-1)?.id ?? null,
    };
  }

  @Get('models/claude/:model')
  retrieveClaudeModel(@Param('model') model: string, @Res() res: FastifyReply) {
    const matched = this.findClaudeModelId(model);
    if (!matched) {
      res.status(HttpStatus.NOT_FOUND).send({
        type: 'error',
        error: {
          type: 'not_found_error',
          message: `model: ${model}`,
        },
      });
      return;
    }

    res.status(HttpStatus.OK).send(this.toClaudeModelMetadata(matched));
  }

  private toClaudeModelMetadata(id: string) {
    return {
      type: 'model' as const,
      id,
      display_name: id,
      // This is a local gateway directory; provider release dates are unknown.
      created_at: '1970-01-01T00:00:00Z',
    };
  }

  @Post('messages/count_tokens')
  async countTokens(@Body() body: AnthropicChatRequest, @Res() res: FastifyReply) {
    try {
      const request = await this.expandFileHandles(body);
      const result = await this.proxyService.handleAnthropicCountTokensWithSource(request);
      res.header('X-AGM-Count-Tokens-Source', result.source);
      if (result.reason) {
        res.header('X-AGM-Count-Tokens-Reason', formatCountTokensReason(result.reason));
      }
      res.status(HttpStatus.OK).send({ input_tokens: result.totalTokens });
    } catch (error) {
      if (error instanceof FileReferenceError) {
        this.sendFileReferenceError(res, 'anthropic', error);
        return;
      }
      this.sendAnthropicErrorResponse(res, '/v1/messages/count_tokens', error);
    }
  }

  private listClaudeModelIds(): string[] {
    const config = getServerConfig();
    const onlyRawQuotaModels = config?.only_raw_quota_models ?? false;
    const dynamicModelIds = onlyRawQuotaModels
      ? this.accountLeaseService?.getAllRawQuotaModels()
      : this.accountLeaseService?.getAllCollectedModels();
    const physicalIds = new Set(dynamicModelIds);
    return getAllDynamicModels(
      getPublishedModelMapping(config),
      physicalIds,
      onlyRawQuotaModels,
    ).filter(
      (id) =>
        tryResolveModelDiscoveryMetadata(
          id,
          this.accountLeaseService,
          config,
          physicalIds.has(id),
        ) !== undefined,
    );
  }

  private findClaudeModelId(model: string): string | undefined {
    const modelIds = this.listClaudeModelIds();
    const exact = modelIds.find((id) => id === model);
    if (exact) {
      return exact;
    }
    const folded = modelIds.filter((id) => id.toLowerCase() === model.toLowerCase());
    return folded.length === 1 ? folded[0] : undefined;
  }

  @Post('messages')
  async anthropicMessages(
    @Body() body: AnthropicChatRequest,
    @Res() res: FastifyReply,
    @Req() req?: FastifyRequest,
  ) {
    const abortScope = createProxyRequestAbortScope(req, res);
    const deadline = new GenerationDeadlineScope(getGenerationTimeoutMs(), abortScope.signal);
    try {
      const request = await awaitRequestOperation(this.expandFileHandles(body), deadline.signal);
      const context = req ? { headers: req.headers, url: req.url } : undefined;
      const result = await awaitRequestOperation(
        this.proxyService.handleAnthropicMessages(request, context, deadline.signal),
        deadline.signal,
      );

      const acknowledgementSource = isCoworkLocalAcknowledgement(result)
        ? 'local_compaction_acknowledgement'
        : undefined;
      if (body.stream && this.isObservableLike(result)) {
        const stream = deadline.retainObservable(result);
        if (acknowledgementSource) {
          // The SSE writer hijacks Fastify and writes the raw response headers.
          res.raw.setHeader('X-AGM-Response-Source', acknowledgementSource);
        }
        this.writeSseResponse(res, stream, true);
        return;
      } else {
        if (acknowledgementSource) {
          res.header('X-AGM-Response-Source', acknowledgementSource);
        }
        setProxyResponseTimingHeaders(res, req);
        res.status(HttpStatus.OK).send(result);
      }
    } catch (error) {
      if (error instanceof FileReferenceError) {
        this.sendFileReferenceError(res, 'anthropic', error);
        return;
      }
      if (error instanceof CoworkCompactionControl && error.outcome.kind === 'trigger') {
        res.header('X-AGM-Response-Source', 'local_compaction_trigger');
        res.header('X-AGM-Compaction-Operation', error.outcome.operationId);
        res.status(HttpStatus.BAD_REQUEST).send({
          type: 'error',
          error: { type: 'invalid_request_error', message: error.message },
        });
        return;
      }
      this.sendAnthropicErrorResponse(res, '/v1/messages', error);
    } finally {
      abortScope.dispose();
      if (!deadline.retained || deadline.signal.aborted) {
        deadline.dispose();
      }
    }
  }

  /**
   * Turns any `file_id` source in the request into the inline bytes the
   * upstream transport takes, before anything else looks at the body.
   */
  private expandFileHandles(body: AnthropicChatRequest): Promise<AnthropicChatRequest> {
    return expandFileReferences(body, 'anthropic', this.files);
  }
}
