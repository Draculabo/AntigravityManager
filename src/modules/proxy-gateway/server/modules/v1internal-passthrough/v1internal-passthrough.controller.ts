import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { V1InternalPassthroughService } from './v1internal-passthrough.service';

/** A vendor method name and nothing else: no path segments, no query, no traversal. */
const V1INTERNAL_VERB_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/u;

@Controller('v1internal')
@UseGuards(ProxyGuard)
export class V1InternalPassthroughController {
  constructor(
    @Inject(V1InternalPassthroughService)
    private readonly passthroughService: V1InternalPassthroughService,
  ) {}

  @Post(':verb')
  async post(
    @Param('verb') verb: string,
    @Body() body: unknown,
    @Res() response: FastifyReply,
  ): Promise<void> {
    if (!V1INTERNAL_VERB_PATTERN.test(verb)) {
      throw new BadRequestException('v1internal verb must be an alphanumeric method name');
    }

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
