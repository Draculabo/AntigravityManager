import { Body, Controller, Inject, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { V1InternalPassthroughService } from './v1internal-passthrough.service';

@Controller('v1internal')
@UseGuards(ProxyGuard)
export class V1InternalPassthroughController {
  constructor(
    @Inject(V1InternalPassthroughService)
    private readonly passthroughService: V1InternalPassthroughService,
  ) {}

  @Post('countTokens')
  async countTokens(@Body() body: unknown, @Res() response: FastifyReply): Promise<void> {
    await this.forward('countTokens', body, response);
  }

  @Post('embedContent')
  async embedContent(@Body() body: unknown, @Res() response: FastifyReply): Promise<void> {
    await this.forward('embedContent', body, response);
  }

  @Post('generateChat')
  async generateChat(@Body() body: unknown, @Res() response: FastifyReply): Promise<void> {
    await this.forward('generateChat', body, response);
  }

  private async forward(verb: string, body: unknown, response: FastifyReply): Promise<void> {
    const upstream = await this.passthroughService.forward(verb, body);
    for (const [name, value] of Object.entries(upstream.headers)) {
      response.header(name, value);
    }

    response
      .header('x-antigravity-v1internal-account-id', upstream.accountId)
      .header('x-antigravity-v1internal-account-email', upstream.accountEmail)
      .status(upstream.status)
      .send(upstream.body);
  }
}
