import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Optional,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { name, version } from '../../../../../package.json';
import { ProxyGuard } from '../../guards/proxy.guard';
import { AccountLeaseService } from '../account-lease/account-lease.service';
import { modelNotFoundError, readOpenAIModelCatalog } from './openai-model-catalog';

const PropsQuerySchema = z.object({ model: z.string().min(1).optional() });

@Controller()
@UseGuards(ProxyGuard)
export class OpenAIProbesController {
  public constructor(
    @Optional() @Inject(AccountLeaseService) private readonly accounts?: AccountLeaseService,
  ) {}

  @Get(['props', 'v1/props'])
  public props(@Query() query: unknown, @Res() res: FastifyReply): void {
    const parsed = PropsQuerySchema.safeParse(query);
    if (!parsed.success) {
      res.status(HttpStatus.BAD_REQUEST).send({
        error: {
          code: 'invalid_parameter',
          message: 'model must be a single non-empty string.',
          param: 'model',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    const model = parsed.data.model ?? 'gemini-3-flash';
    const entry = readOpenAIModelCatalog(this.accounts).find((item) => item.id === model);
    if (!entry) {
      res.status(HttpStatus.NOT_FOUND).send(modelNotFoundError(model));
      return;
    }

    res.status(HttpStatus.OK).send({
      default_generation_settings: {
        n_ctx: entry.context_length,
        n_predict: entry.max_completion_tokens,
      },
      // llama.cpp compatibility only; this gateway does not measure model slots.
      total_slots: 1,
      model_alias: entry.id,
    });
  }

  @Get(['version', 'v1/version'])
  public version() {
    return { version, app: name, name };
  }
}
