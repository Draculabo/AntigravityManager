import {
  Body,
  Controller,
  HttpStatus,
  Inject,
  Optional,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { AnthropicChatRequest } from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import { BaseProxyController } from '@/modules/proxy-gateway/server/common/base-proxy.controller';
import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';
import { FileContentStore } from '@/modules/proxy-gateway/server/modules/files/file-content-store.service';
import {
  expandFileReferences,
  FileReferenceError,
} from '@/modules/proxy-gateway/server/modules/files/file-reference-expander';
import { AnthropicService } from './anthropic.service';

@Controller('v1')
@UseGuards(ProxyGuard)
export class AnthropicController extends BaseProxyController {
  constructor(
    @Inject(AnthropicService) private readonly proxyService: AnthropicService,
    @Optional() @Inject(FileContentStore) private readonly fileStore?: FileContentStore,
  ) {
    super();
  }

  @Post('messages/count_tokens')
  async countTokens(@Body() body: AnthropicChatRequest, @Res() res: FastifyReply) {
    try {
      const request = await this.expandFileHandles(body);
      const inputTokens = await this.proxyService.handleAnthropicCountTokens(request);
      res.status(HttpStatus.OK).send({ input_tokens: inputTokens });
    } catch (error) {
      if (error instanceof FileReferenceError) {
        this.sendFileReferenceError(res, 'anthropic', error);
        return;
      }
      this.sendAnthropicErrorResponse(res, '/v1/messages/count_tokens', error);
    }
  }

  @Post('messages')
  async anthropicMessages(@Body() body: AnthropicChatRequest, @Res() res: FastifyReply) {
    try {
      const request = await this.expandFileHandles(body);
      const result = await this.proxyService.handleAnthropicMessages(request);

      if (body.stream && this.isObservableLike(result)) {
        this.writeSseResponse(res, result);
        return;
      } else {
        res.status(HttpStatus.OK).send(result);
      }
    } catch (error) {
      if (error instanceof FileReferenceError) {
        this.sendFileReferenceError(res, 'anthropic', error);
        return;
      }
      this.sendAnthropicErrorResponse(res, '/v1/messages', error);
    }
  }

  /**
   * Turns any `file_id` source in the request into the inline bytes the
   * upstream transport takes, before anything else looks at the body.
   */
  private expandFileHandles(body: AnthropicChatRequest): Promise<AnthropicChatRequest> {
    return expandFileReferences(body, 'anthropic', this.fileStore);
  }
}
