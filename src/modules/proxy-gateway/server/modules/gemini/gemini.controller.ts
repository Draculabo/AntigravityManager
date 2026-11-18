import { getGenerationTimeoutMs } from '../../common/generation-timeout-policy';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  Optional,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { isEmpty, isNumber } from 'lodash-es';
import { Observable } from 'rxjs';

import { ProxyGuard } from '../../guards/proxy.guard';
import { getPublishedModelMapping } from '@/modules/config/model-aliases';
import { FilesService } from '@/modules/proxy-gateway/server/modules/files/files.service';
import {
  expandFileReferences,
  FileReferenceError,
} from '@/modules/proxy-gateway/server/modules/files/file-reference-expander';
import { BatchService } from '../batch/batch.service';
import { respondGeminiBatchGenerateContent } from '../batch/gemini-batch-submit';
import { GeminiService } from './gemini.service';
import { InvalidCountTokensRequestError } from './gemini-count-tokens';
import { GeminiRequest, GeminiResponse } from '../../common/interfaces/request-interfaces';
import { getServerConfig } from '../../../../../server/server-config';
import { getAllDynamicModels } from '../../../antigravity/ModelMapping';
import {
  resolveModelDiscoveryMetadata,
  tryResolveModelDiscoveryMetadata,
} from '../../shared/services/model-discovery-metadata';
import { AccountLeaseService } from '../account-lease/account-lease.service';
import { resolveUpstreamErrorHttpStatus } from '../../common/upstream-error-http-status';
import { publicProxyErrorMessage } from '../../common/public-error-message';
import { publicGoogleErrorDetails } from '../../common/upstream-error-codec';
import { UpstreamRequestError } from '../../common/exceptions/upstream-request.exception';
import {
  applyProxyRetryAfterHeader,
  createProxyRequestAbortScope,
} from '../../common/base-proxy.controller';
import { formatCountTokensReason } from '../../common/base-proxy.service';
import { setProxyResponseTimingHeaders } from '../../common/proxy-response-timing';
import { GenerationDeadlineScope } from '../../common/generation-deadline';
import { awaitRequestOperation } from '../../common/request-cancellation';
import { writeProxySseResponse } from '../../common/proxy-sse-response';
import { GenerationDeadlineExceededError } from '../../common/exceptions/generation-deadline.exception';

type GeminiModelMetadata = {
  name: string;
  displayName: string;
  description: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  supports_images?: boolean;
  supports_thinking?: boolean;
  capability_source?: 'provider-catalog';
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
    @Optional() @Inject(FilesService) private readonly files?: FilesService,
    @Optional() @Inject(BatchService) private readonly batches?: BatchService,
  ) {}

  @Get('models')
  listModels() {
    const models = this.buildGeminiModelList();
    return {
      models,
    };
  }

  @Get('models/:model')
  getModel(@Param('model') model: string) {
    const targetName = model.startsWith('models/') ? model : `models/${model}`;
    const models = this.buildGeminiModelList();
    const exact = models.find((item) => item.name === targetName);
    const folded = exact
      ? []
      : models.filter((item) => item.name.toLowerCase() === targetName.toLowerCase());
    const matched = exact ?? (folded.length === 1 ? folded[0] : undefined);

    if (matched) {
      return matched;
    }

    throw new NotFoundException(`Model '${targetName}' was not found`);
  }

  @Post('models/:modelAction')
  async modelAction(
    @Param('modelAction') modelAction: string,
    @Body() body: GeminiRequest,
    @Res() res: FastifyReply,
    @Req() req?: FastifyRequest,
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

    await this.handleModelActionDispatch(parsed.model, parsed.action, body, res, req);
  }

  @Post('models/:model/countTokens')
  async countTokens(
    @Param('model') model: string,
    @Body() body: GeminiRequest,
    @Res() res: FastifyReply,
    @Req() req?: FastifyRequest,
  ) {
    await this.handleModelActionDispatch(`models/${model}`, 'countTokens', body, res, req);
  }

  private async handleModelActionDispatch(
    model: string,
    action: string,
    body: GeminiRequest,
    res: FastifyReply,
    req?: FastifyRequest,
  ): Promise<void> {
    const abortScope = createProxyRequestAbortScope(req, res);
    const deadline =
      action === 'generateContent' || action === 'streamGenerateContent'
        ? new GenerationDeadlineScope(getGenerationTimeoutMs(), abortScope.signal)
        : undefined;
    const signal = deadline?.signal ?? abortScope.signal;
    try {
      let request: GeminiRequest;
      try {
        // Handles become inline bytes before anything else reads the request:
        // the upstream transport has no file plane to forward a `fileUri` to.
        request = await awaitRequestOperation(
          expandFileReferences(body, 'gemini', this.files),
          signal,
        );
      } catch (error) {
        if (error instanceof FileReferenceError) {
          res.status(error.httpStatus).send({
            error: {
              code: error.httpStatus,
              message: publicProxyErrorMessage(error.message),
              status: error.httpStatus === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT',
            },
          });
          return;
        }
        throw error;
      }

      if (action === 'countTokens') {
        const result = await this.proxyService.handleGeminiCountTokensWithSource(
          model,
          request,
          signal,
        );
        res.header('X-AGM-Count-Tokens-Source', result.source);
        if (result.reason) {
          res.header('X-AGM-Count-Tokens-Reason', formatCountTokensReason(result.reason));
        }
        res.status(HttpStatus.OK).send({ totalTokens: result.totalTokens });
        return;
      }

      if (action === 'streamGenerateContent') {
        const stream = await this.proxyService.handleGeminiStreamGenerateContent(
          model,
          request,
          signal,
          { headers: req?.headers ?? {}, url: req?.url },
        );
        if (stream instanceof Observable) {
          writeProxySseResponse(res, deadline ? deadline.retainObservable(stream) : stream, {
            includeTiming: true,
            request: req,
            formatUnstartedError: (error) => {
              if (error instanceof GenerationDeadlineExceededError) {
                const status = HttpStatus.GATEWAY_TIMEOUT;
                return { status, body: this.buildErrorResponse(status, error) };
              }
              return undefined;
            },
          });
          return;
        }
      }

      if (action === 'generateContent') {
        const result = await this.proxyService.handleGeminiGenerateContent(
          model,
          request,
          'generate-content',
          signal,
          'gemini',
          { headers: req?.headers ?? {}, url: req?.url },
        );
        setProxyResponseTimingHeaders(res, req);
        res.status(HttpStatus.OK).send(this.buildNormalizedGeminiGenerateResponse(result));
        return;
      }

      if (action === 'batchGenerateContent') {
        await respondGeminiBatchGenerateContent(this.batches, model, request, res);
        return;
      }

      res.status(HttpStatus.BAD_REQUEST).send({
        error: {
          code: HttpStatus.BAD_REQUEST,
          message: publicProxyErrorMessage(`Unsupported model action: ${action}`),
          status: 'INVALID_ARGUMENT',
        },
      });
    } catch (error) {
      if (error instanceof InvalidCountTokensRequestError || error instanceof BadRequestException) {
        res.status(HttpStatus.BAD_REQUEST).send({
          error: {
            code: HttpStatus.BAD_REQUEST,
            message: publicProxyErrorMessage(error.message),
            status: 'INVALID_ARGUMENT',
          },
        });
        return;
      }

      const status =
        error instanceof HttpException
          ? (error.getStatus() as HttpStatus)
          : (resolveUpstreamErrorHttpStatus(error) ?? HttpStatus.INTERNAL_SERVER_ERROR);
      applyProxyRetryAfterHeader(res, error);
      res.status(status).send(this.buildErrorResponse(status, error));
    } finally {
      abortScope.dispose();
      if (deadline && (!deadline.retained || deadline.signal.aborted)) {
        deadline.dispose();
      }
    }
  }

  private buildErrorResponse(status: HttpStatus, error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    const details =
      error instanceof UpstreamRequestError ? publicGoogleErrorDetails(error.details) : undefined;
    return {
      error: {
        code: status,
        message: publicProxyErrorMessage(message),
        status:
          (error instanceof UpstreamRequestError ? error.upstreamStatus : undefined) ??
          this.resolveGeminiErrorStatus(status),
        ...(details ? { details } : {}),
      },
    };
  }

  private resolveGeminiErrorStatus(status: HttpStatus): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'INVALID_ARGUMENT';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHENTICATED';
      case HttpStatus.FORBIDDEN:
        return 'PERMISSION_DENIED';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.REQUEST_TIMEOUT:
      case HttpStatus.GATEWAY_TIMEOUT:
        return 'DEADLINE_EXCEEDED';
      case HttpStatus.CONFLICT:
        return 'ABORTED';
      case HttpStatus.PRECONDITION_FAILED:
        return 'FAILED_PRECONDITION';
      case HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE:
        return 'OUT_OF_RANGE';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RESOURCE_EXHAUSTED';
      case HttpStatus.NOT_IMPLEMENTED:
        return 'UNIMPLEMENTED';
      case HttpStatus.SERVICE_UNAVAILABLE:
        return 'UNAVAILABLE';
      default:
        return 'INTERNAL';
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
    const physicalIds = new Set(collectedModelIds);
    const dynamicModelIds = getAllDynamicModels(
      getPublishedModelMapping(config),
      physicalIds,
      onlyRawQuotaModels,
    );

    return dynamicModelIds.flatMap((id) => {
      const metadata = tryResolveModelDiscoveryMetadata(
        id,
        this.accountLeaseService,
        config,
        physicalIds.has(id),
      );
      return metadata ? [this.toGeminiModelMetadata(`models/${id}`, metadata)] : [];
    });
  }

  private toGeminiModelMetadata(
    modelName: string,
    limits: ReturnType<typeof resolveModelDiscoveryMetadata>,
  ): GeminiModelMetadata {
    const displayName = modelName.replace(/^models\//, '');
    return {
      name: modelName,
      displayName,
      description: '',
      inputTokenLimit: limits.context,
      outputTokenLimit: limits.output,
      ...(limits.capabilities.supports_images !== undefined
        ? { supports_images: limits.capabilities.supports_images }
        : {}),
      ...(limits.capabilities.supports_thinking !== undefined
        ? { supports_thinking: limits.capabilities.supports_thinking }
        : {}),
      ...(Object.keys(limits.capabilities).length
        ? { capability_source: 'provider-catalog' as const }
        : {}),
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
}
