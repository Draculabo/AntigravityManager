import { randomBytes } from 'node:crypto';

import { Body, Controller, HttpStatus, Inject, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Observable } from 'rxjs';

import { ProxyGuard } from '../../guards/proxy.guard';
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
  async complete(@Body() body: unknown, @Res() res: FastifyReply): Promise<void> {
    const requestId = `req_${randomBytes(12).toString('hex')}`;
    try {
      const request = normalizeAnthropicCompleteRequest(body);
      if (request.stream) {
        throw new AnthropicCompleteValidationError(
          'stream is not supported on the deprecated /v1/complete endpoint; use /v1/messages for streaming',
        );
      }
      const messagesRequest = toAnthropicMessagesRequest(request);
      const result = await this.proxyService.handleAnthropicMessages(messagesRequest);
      if (result instanceof Observable) {
        // Defensive: `handleAnthropicMessages` only streams when `stream` is
        // truthy on the request, which is refused above, but an Observable is
        // never a valid answer to this endpoint either way.
        throw new AnthropicCompleteValidationError(
          'Upstream returned a stream for a non-streaming request',
        );
      }
      const message = result;
      res
        .header('request-id', requestId)
        .status(HttpStatus.OK)
        .send(
          toAnthropicCompletionResponse(
            message,
            request.model,
            `compl_${requestId.slice('req_'.length)}`,
          ),
        );
    } catch (error) {
      const { statusCode, body: envelope } = anthropicCompleteErrorResponse(error, requestId);
      res.header('request-id', requestId).status(statusCode).send(envelope);
    }
  }
}
