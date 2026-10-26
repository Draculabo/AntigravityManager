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
import { AnthropicChatRequest } from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import {
  BaseProxyController,
  createProxyRequestAbortScope,
} from '@/modules/proxy-gateway/server/common/base-proxy.controller';
import { formatCountTokensReason } from '@/modules/proxy-gateway/server/common/base-proxy.service';
import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';
import { FilesService } from '@/modules/proxy-gateway/server/modules/files/files.service';
import {
  expandFileReferences,
  FileReferenceError,
} from '@/modules/proxy-gateway/server/modules/files/file-reference-expander';
import { AnthropicService } from './anthropic.service';
import { setProxyResponseTimingHeaders } from '../../common/proxy-response-timing';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { getConfiguredModelMapping } from '@/modules/config/model-aliases';
import { getServerConfig } from '@/server/server-config';
import { getAllDynamicModels } from '@/modules/proxy-gateway/antigravity/ModelMapping';

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
    return {
      object: 'list',
      data: this.listClaudeModelIds().map((id) => ({
        id,
        object: 'model',
        created: 1706745600,
        owned_by: 'antigravity',
      })),
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

    res.status(HttpStatus.OK).send({
      type: 'model',
      id: matched,
      display_name: matched,
      created_at: '2024-10-22T00:00:00Z',
    });
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
    return getAllDynamicModels(
      getConfiguredModelMapping(config),
      dynamicModelIds,
      onlyRawQuotaModels,
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
    try {
      const request = await this.expandFileHandles(body);
      const context = req ? { headers: req.headers, url: req.url } : undefined;
      const result = await (abortScope.signal
        ? this.proxyService.handleAnthropicMessages(request, context, abortScope.signal)
        : this.proxyService.handleAnthropicMessages(request, context));

      if (body.stream && this.isObservableLike(result)) {
        this.writeSseResponse(res, result, true);
        return;
      } else {
        setProxyResponseTimingHeaders(res, req);
        res.status(HttpStatus.OK).send(result);
      }
    } catch (error) {
      if (error instanceof FileReferenceError) {
        this.sendFileReferenceError(res, 'anthropic', error);
        return;
      }
      this.sendAnthropicErrorResponse(res, '/v1/messages', error);
    } finally {
      abortScope.dispose();
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
