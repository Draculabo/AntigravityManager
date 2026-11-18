import { randomBytes } from 'node:crypto';

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';

import { ProxyGuard } from '../../guards/proxy.guard';
import { ProtocolErrors } from '../../common/protocol-errors.decorator';
import {
  AnthropicCompleteValidationError,
  anthropicCompleteErrorResponse,
  normalizeAnthropicCompleteRequest,
  toAnthropicCompletionResponse,
  toAnthropicMessagesRequest,
} from './anthropic-text-completion';
import { AnthropicService } from './anthropic.service';

/**
 * Anthropic's deprecated Text Completions endpoint.
 *
 * Small and entirely derived: the prompt is parsed back into Messages turns
 * and run down `AnthropicService.handleAnthropicMessages`, then rendered back
 * into the old response shape. It is a separate thin controller rather than
 * another method on `AnthropicController`.
 *
 * Streaming is refused instead of half-served: the old `completion` event
 * stream is a different wire format from the Messages SSE this proxy
 * produces, and silently returning Messages events to a Text Completions
 * client would be worse than a clear 400.
 */
@Controller('v1/complete')
@UseGuards(ProxyGuard)
export class AnthropicCompleteController {
  constructor(@Inject(AnthropicService) private readonly proxyService: AnthropicService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ProtocolErrors((error, _request, reply) =>
    anthropicCompleteErrorResponse(error, String(reply.getHeader('request-id'))),
  )
  async complete(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: FastifyReply,
    @Req() req?: FastifyRequest,
  ) {
    const requestId = `req_${randomBytes(12).toString('hex')}`;
    res.header('request-id', requestId);
    const request = normalizeAnthropicCompleteRequest(body);
    if (request.stream) {
      throw new AnthropicCompleteValidationError(
        'stream is not supported on the deprecated /v1/complete endpoint; use /v1/messages for streaming',
      );
    }
    const messagesRequest = toAnthropicMessagesRequest(request);
    const result = await this.proxyService.handleAnthropicMessages(
      messagesRequest,
      req ? { headers: req.headers, url: req.url } : undefined,
    );
    if (result instanceof Observable) {
      // Messages SSE is never a valid answer to the legacy completion protocol.
      throw new AnthropicCompleteValidationError(
        'Upstream returned a stream for a non-streaming request',
      );
    }
    return toAnthropicCompletionResponse(
      result,
      request.model,
      `compl_${requestId.slice('req_'.length)}`,
    );
  }
}
