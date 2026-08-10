import { Body, Controller, HttpStatus, Inject, Post, Res, UseGuards } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { AnthropicChatRequest } from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import { BaseProxyController } from '@/modules/proxy-gateway/server/common/base-proxy.controller';
import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';
import { AnthropicService } from './anthropic.service';

@Controller('v1')
@UseGuards(ProxyGuard)
export class AnthropicController extends BaseProxyController {
  constructor(@Inject(AnthropicService) private readonly proxyService: AnthropicService) {
    super();
  }

  @Post('messages')
  async anthropicMessages(@Body() body: AnthropicChatRequest, @Res() res: FastifyReply) {
    try {
      const result = await this.proxyService.handleAnthropicMessages(body);

      if (body.stream && this.isObservableLike(result)) {
        this.writeSseResponse(res, result);
        return;
      } else {
        res.status(HttpStatus.OK).send(result);
      }
    } catch (error) {
      this.sendAnthropicErrorResponse(res, '/v1/messages', error);
    }
  }
}
