import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
  Optional,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { isEmpty, isFunction, isNumber, isString } from 'lodash-es';
import { Observable } from 'rxjs';

import { ProxyGuard } from '../../guards/proxy.guard';
import { FileContentStore } from '@/modules/proxy-gateway/server/modules/files/file-content-store.service';
import {
  expandFileReferences,
  FileReferenceError,
} from '@/modules/proxy-gateway/server/modules/files/file-reference-expander';
import { GeminiService } from './gemini.service';
import { InvalidCountTokensRequestError } from './gemini-count-tokens';
import { GeminiRequest, GeminiResponse } from '../../common/interfaces/request-interfaces';
import { getServerConfig } from '../../../../../server/server-config';
import { getAllDynamicModels } from '../../../antigravity/ModelMapping';
import { AccountLeaseService } from '../account-lease/account-lease.service';

type GeminiModelMetadata = {
  name: string;
  displayName: string;
  description: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  supportedGenerationMethods: string[];
  temperature: number;
  topK: number;
  topP: number;
  version: string;
};

@Controller('v1beta')
@UseGuards(ProxyGuard)
export class GeminiController {
  constructor(
    @Inject(GeminiService) private readonly proxyService: GeminiService,
    @Optional()
    @Inject(AccountLeaseService)
    private readonly accountLeaseService?: AccountLeaseService,
    @Optional() @Inject(FileContentStore) private readonly fileStore?: FileContentStore,
  ) {}

  @Get('models')
  listModels(@Res() res: FastifyReply) {
    const models = this.buildGeminiModelList();
    res.status(HttpStatus.OK).send({
      models,
    });
  }

  @Get('models/:model')
  getModel(@Param('model') model: string, @Res() res: FastifyReply) {
    const targetName = model.startsWith('models/') ? model : `models/${model}`;
    const matched = this.buildGeminiModelList().find((item) => item.name === targetName);

    if (matched) {
      res.status(HttpStatus.OK).send({
        name: matched.name,
        displayName: matched.displayName,
      });
      return;
    }

    res.status(HttpStatus.OK).send({
      name: targetName,
      displayName: targetName.replace(/^models\//, ''),
    });
  }

  @Post('models/:modelAction')
  async modelAction(
    @Param('modelAction') modelAction: string,
    @Body() body: GeminiRequest,
    @Res() res: FastifyReply,
  ) {
    const parsed = this.parseModelActionToken(modelAction);
    if (!parsed) {
      res.status(HttpStatus.BAD_REQUEST).send({
        error: {
          code: HttpStatus.BAD_REQUEST,
          message: 'Model action format is invalid',
          status: 'INVALID_ARGUMENT',
        },
      });
      return;
    }

    await this.handleModelActionDispatch(parsed.model, parsed.action, body, res);
  }

  @Post('models/:model/countTokens')
  async countTokens(
    @Param('model') model: string,
    @Body() body: GeminiRequest,
    @Res() res: FastifyReply,
  ) {
    await this.handleModelActionDispatch(`models/${model}`, 'countTokens', body, res);
  }

  private async handleModelActionDispatch(
    model: string,
    action: string,
    body: GeminiRequest,
    res: FastifyReply,
  ): Promise<void> {
    let request: GeminiRequest;
    try {
      // Handles become inline bytes before anything else reads the request:
      // the upstream transport has no file plane to forward a `fileUri` to.
      request = await expandFileReferences(body, 'gemini', this.fileStore);
    } catch (error) {
      if (error instanceof FileReferenceError) {
        res.status(error.httpStatus).send({
          error: {
            code: error.httpStatus,
            message: error.message,
            status: error.httpStatus === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT',
          },
        });
        return;
      }
      throw error;
    }

    try {
      if (action === 'countTokens') {
        const totalTokens = await this.proxyService.handleGeminiCountTokens(model, request);
        res.status(HttpStatus.OK).send({ totalTokens });
        return;
      }

      if (action === 'streamGenerateContent') {
        const stream = await this.proxyService.handleGeminiStreamGenerateContent(model, request);
        if (stream instanceof Observable) {
          this.writeObservableSseResponse(res, stream);
          return;
        }
      }

      if (action === 'generateContent') {
        const result = await this.proxyService.handleGeminiGenerateContent(model, request);
        res.status(HttpStatus.OK).send(this.buildNormalizedGeminiGenerateResponse(result));
        return;
      }

      res.status(HttpStatus.BAD_REQUEST).send({
        error: {
          code: HttpStatus.BAD_REQUEST,
          message: `Unsupported model action: ${action}`,
          status: 'INVALID_ARGUMENT',
        },
      });
    } catch (error) {
      if (error instanceof InvalidCountTokensRequestError) {
        res.status(HttpStatus.BAD_REQUEST).send({
          error: {
            code: HttpStatus.BAD_REQUEST,
            message: error.message,
            status: 'INVALID_ARGUMENT',
          },
        });
        return;
      }

      const message = error instanceof Error ? error.message : 'Internal Server Error';
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
        error: {
          code: HttpStatus.INTERNAL_SERVER_ERROR,
          message,
          status: 'INTERNAL',
        },
      });
    }
  }

  private parseModelActionToken(modelAction: string): {
    model: string;
    action: string;
  } | null {
    const colonIndex = modelAction.lastIndexOf(':');
    if (colonIndex <= 0) {
      return null;
    }

    const model = modelAction.slice(0, colonIndex).trim();
    const action = modelAction.slice(colonIndex + 1).trim();
    if (!model || !action) {
      return null;
    }

    const prefixedModel = model.startsWith('models/') ? model : `models/${model}`;
    return {
      model: prefixedModel,
      action,
    };
  }

  private buildGeminiModelList(): GeminiModelMetadata[] {
    const config = getServerConfig();
    const onlyRawQuotaModels = config?.only_raw_quota_models ?? false;
    const collectedModelIds = onlyRawQuotaModels
      ? this.accountLeaseService?.getAllRawQuotaModels()
      : this.accountLeaseService?.getAllCollectedModels();
    const dynamicModelIds = getAllDynamicModels(
      config?.custom_mapping ?? {},
      collectedModelIds,
      onlyRawQuotaModels,
    );

    return dynamicModelIds.map((id) => this.toGeminiModelMetadata(`models/${id}`));
  }

  private toGeminiModelMetadata(modelName: string): GeminiModelMetadata {
    const displayName = modelName.replace(/^models\//, '');
    return {
      name: modelName,
      displayName,
      description: '',
      inputTokenLimit: 128000,
      outputTokenLimit: 8192,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
      temperature: 1,
      topK: 64,
      topP: 0.95,
      version: '001',
    };
  }

  private buildNormalizedGeminiGenerateResponse(response: GeminiResponse): GeminiResponse {
    const candidates = (response.candidates ?? []).map((candidate, index) => ({
      content: candidate.content,
      finishReason: candidate.finishReason,
      index: isNumber(candidate.index) ? candidate.index : index,
    }));

    const normalized: GeminiResponse = {
      candidates,
      promptFeedback: response.promptFeedback,
    };

    if (response.usageMetadata) {
      const usageMetadata = this.normalizeGeminiUsageMetadata(response.usageMetadata);
      if (!isEmpty(usageMetadata)) {
        normalized.usageMetadata = usageMetadata;
      }
    }

    return normalized;
  }

  private normalizeGeminiUsageMetadata(
    usageMetadata: GeminiResponse['usageMetadata'],
  ): NonNullable<GeminiResponse['usageMetadata']> {
    const normalized: NonNullable<GeminiResponse['usageMetadata']> = {};
    if (usageMetadata?.promptTokenCount !== undefined) {
      normalized.promptTokenCount = usageMetadata.promptTokenCount;
    }
    if (usageMetadata?.candidatesTokenCount !== undefined) {
      normalized.candidatesTokenCount = usageMetadata.candidatesTokenCount;
    }
    if (usageMetadata?.totalTokenCount !== undefined) {
      normalized.totalTokenCount = usageMetadata.totalTokenCount;
    }
    if (usageMetadata?.thoughtsTokenCount !== undefined) {
      normalized.thoughtsTokenCount = usageMetadata.thoughtsTokenCount;
    }
    if (usageMetadata?.promptTokensDetails !== undefined) {
      normalized.promptTokensDetails = usageMetadata.promptTokensDetails;
    }
    if (usageMetadata?.candidatesTokensDetails !== undefined) {
      normalized.candidatesTokensDetails = usageMetadata.candidatesTokensDetails;
    }
    if (usageMetadata?.trafficType !== undefined) {
      normalized.trafficType = usageMetadata.trafficType;
    }
    return normalized;
  }

  private writeObservableSseResponse(res: FastifyReply, stream: Observable<unknown>): void {
    if (!res.raw || !isFunction(res.raw.writeHead) || !isFunction(res.raw.write)) {
      res.header('Content-Type', 'text/event-stream');
      res.header('Cache-Control', 'no-cache');
      res.header('Connection', 'keep-alive');
      res.send(stream);
      return;
    }

    if (this.supportsReplyHijack(res)) {
      res.hijack();
    }

    res.raw.writeHead(HttpStatus.OK, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const subscription = stream.subscribe({
      next: (chunk) => {
        if (res.raw.writableEnded) {
          return;
        }
        const payload = isString(chunk) ? chunk : String(chunk ?? '');
        res.raw.write(payload);
      },
      error: (error) => {
        if (res.raw.writableEnded) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        res.raw.write(
          `data: ${JSON.stringify({
            error: {
              message,
              type: 'server_error',
            },
          })}\n\n`,
        );
        res.raw.end();
      },
      complete: () => {
        if (!res.raw.writableEnded) {
          res.raw.end();
        }
      },
    });

    res.raw.on('close', () => {
      subscription.unsubscribe();
    });
  }

  private supportsReplyHijack(reply: FastifyReply): reply is FastifyReply & { hijack: () => void } {
    return isFunction((reply as { hijack?: unknown }).hijack);
  }
}
