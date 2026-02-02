import { Controller, Get, Post, Body, Res, HttpStatus, UseGuards, Inject } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { ProxyService } from './proxy.service';
import { Observable } from 'rxjs';
import { OpenAIChatRequest, AnthropicChatRequest } from './interfaces/request-interfaces';
import { ProxyGuard } from './proxy.guard';

@Controller('v1')
@UseGuards(ProxyGuard)
export class ProxyController {
  constructor(@Inject(ProxyService) private readonly proxyService: ProxyService) { }

  @Get('models')
  getModels() {
    return {
      object: 'list',
      data: [
        // Gemini Native
        {
          id: 'gemini-2.5-flash-thinking',
          object: 'model',
          created: 1734336000,
          owned_by: 'google',
        },
        { id: 'gemini-2.5-flash', object: 'model', created: 1734336000, owned_by: 'google' },
        { id: 'gemini-2.5-pro', object: 'model', created: 1734336000, owned_by: 'google' },
        { id: 'gemini-3-flash', object: 'model', created: 1734336000, owned_by: 'google' },

        // Claude Native (Mapped)
        { id: 'claude-sonnet-4-5', object: 'model', created: 1734336000, owned_by: 'anthropic' },
        {
          id: 'claude-sonnet-4-5-thinking',
          object: 'model',
          created: 1734336000,
          owned_by: 'anthropic',
        },

        // Image Models
        { id: 'gemini-3-pro-image', object: 'model', created: 1734336000, owned_by: 'google' },
      ],
    };
  }

  @Post('chat/completions')
  async chatCompletions(@Body() body: OpenAIChatRequest, @Res() res: FastifyReply) {
    try {

      // 🔧 Claude Code CLI compatibility:
      // Claude CLI uses OpenAI-style /v1/chat/completions
      if (body.model?.startsWith('claude-')) {
        const result = await this.proxyService.handleAnthropicMessages(
          body as unknown as AnthropicChatRequest,
        );

        if (body.stream && result instanceof Observable) {
          res.header('Content-Type', 'text/event-stream');
          res.header('Cache-Control', 'no-cache');
          res.header('Connection', 'keep-alive');
          res.send(result);
        } else {
          res.status(HttpStatus.OK).send(result);
        }
        return;
      }


      const result = await this.proxyService.handleChatCompletions(body);

      if (body.stream && result instanceof Observable) {
        res.header('Content-Type', 'text/event-stream');
        res.header('Cache-Control', 'no-cache');
        res.header('Connection', 'keep-alive');
        res.send(result);
      } else {
        res.status(HttpStatus.OK).send(result);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
        error: {
          message: message,
          type: 'server_error',
        },
      });
    }
  }

  @Post('messages')
  async anthropicMessages(@Body() body: AnthropicChatRequest, @Res() res: FastifyReply) {
    try {
      const result = await this.proxyService.handleAnthropicMessages(body);

      if (body.stream && result instanceof Observable) {
        res.header('Content-Type', 'text/event-stream');
        res.header('Cache-Control', 'no-cache');
        res.header('Connection', 'keep-alive');
        res.send(result);
      } else {
        res.status(HttpStatus.OK).send(result);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
        type: 'error',
        error: {
          type: 'api_error',
          message: message,
        },
      });
    }
  }
}
