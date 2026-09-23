import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { isFunction, isObjectLike } from 'lodash-es';
import { Observable } from 'rxjs';
import { writeProxySseResponse } from './proxy-sse-response';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request.exception';
import type { FileReferenceError } from '@/modules/proxy-gateway/server/modules/files/file-reference-expander';
import { ProxyAccountUnavailableError } from '@/modules/proxy-gateway/server/common/exceptions/proxy-account-unavailable.exception';

export function applyProxyRetryAfterHeader(res: FastifyReply, error: unknown): void {
  if (
    error instanceof ProxyAccountUnavailableError &&
    error.retryAfterSeconds !== undefined &&
    Number.isFinite(error.retryAfterSeconds) &&
    error.retryAfterSeconds > 0
  ) {
    res.header('Retry-After', String(Math.ceil(error.retryAfterSeconds)));
  }
}

export function createProxyRequestAbortScope(
  req: FastifyRequest | undefined,
  res: FastifyReply,
): { dispose: () => void; signal?: AbortSignal } {
  if (!req?.raw || !res.raw) {
    return { dispose: () => undefined };
  }
  const controller = new AbortController();
  const abort = (): void => {
    if (!res.raw.writableEnded) {
      controller.abort();
    }
  };
  req.raw.once('aborted', abort);
  res.raw.once('close', abort);
  return {
    signal: controller.signal,
    dispose: () => {
      req.raw.removeListener('aborted', abort);
      res.raw.removeListener('close', abort);
    },
  };
}

export abstract class BaseProxyController {
  protected readonly logger = new Logger(this.constructor.name);

  protected isObservableLike(value: unknown): value is Observable<unknown> {
    return isObjectLike(value) && isFunction((value as { subscribe?: unknown }).subscribe);
  }

  protected createRequestAbortScope(
    req: FastifyRequest | undefined,
    res: FastifyReply,
  ): { dispose: () => void; signal?: AbortSignal } {
    return createProxyRequestAbortScope(req, res);
  }

  protected writeSseResponse(
    res: FastifyReply,
    stream: Observable<unknown>,
    includeTiming = false,
  ): void {
    writeProxySseResponse(res, stream, { includeTiming });
  }

  protected isProjectContextErrorMessage(message: string): boolean {
    const lowered = message.toLowerCase();
    return (
      lowered.includes('#3501') ||
      (lowered.includes('google cloud project') && lowered.includes('code assist license')) ||
      (lowered.includes('resource projects/') && lowered.includes('could not be found')) ||
      (lowered.includes('project') && lowered.includes('not found'))
    );
  }

  private resolveErrorMessageText(error: unknown): string {
    return error instanceof Error ? error.message : 'Internal Server Error';
  }

  /**
   * Answers a file handle this proxy cannot resolve, in the caller's dialect.
   *
   * It is deliberately not routed through the generic error senders: those
   * report `server_error`, and an unknown or expired handle is the client's
   * request being wrong about what exists, not this gateway failing.
   */
  protected sendFileReferenceError(
    res: FastifyReply,
    dialect: 'anthropic' | 'gemini' | 'openai',
    error: FileReferenceError,
  ): void {
    if (dialect === 'anthropic') {
      res.status(error.httpStatus).send({
        type: 'error',
        error: { type: 'invalid_request_error', message: error.message },
      });
      return;
    }
    if (dialect === 'gemini') {
      res.status(error.httpStatus).send({
        error: {
          code: error.httpStatus,
          message: error.message,
          status: error.httpStatus === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT',
        },
      });
      return;
    }
    res.status(error.httpStatus).send({
      error: {
        code: 'file_not_found',
        message: error.message,
        param: error.param,
        type: 'invalid_request_error',
      },
    });
  }

  protected sendOpenAIErrorResponse(
    res: FastifyReply,
    endpoint: string,
    error: unknown,
    overrideMessage?: string,
  ): void {
    const message = overrideMessage ?? this.resolveErrorMessageText(error);
    const status = this.resolveErrorHttpStatus(message, error);
    this.logProxyEndpointError(endpoint, status, message, error);
    applyProxyRetryAfterHeader(res, error);
    res.status(status).send({
      error: {
        message,
        type: 'server_error',
      },
    });
  }

  protected sendAnthropicErrorResponse(
    res: FastifyReply,
    endpoint: string,
    error: unknown,
    overrideMessage?: string,
  ): void {
    const message = overrideMessage ?? this.resolveErrorMessageText(error);
    const status = this.resolveAnthropicErrorHttpStatus(message, error);
    this.logProxyEndpointError(endpoint, status, message, error);
    applyProxyRetryAfterHeader(res, error);
    res.status(status).send({
      type: 'error',
      error: {
        type: 'api_error',
        message,
      },
    });
  }

  /**
   * A terminal upstream 403 means the local account pool could not satisfy an
   * Anthropic request. Claude clients treat a public 403 as an invalid local
   * login and stop retrying, so expose it as temporary gateway unavailability.
   * This stays at the Anthropic boundary: OpenAI and Gemini preserve upstream
   * 403 responses, and the shared retry service remains provider-neutral.
   */
  private resolveAnthropicErrorHttpStatus(message: string, error?: unknown): HttpStatus {
    const status = this.resolveErrorHttpStatus(message, error);
    if (error instanceof UpstreamRequestError && status === HttpStatus.FORBIDDEN) {
      return HttpStatus.SERVICE_UNAVAILABLE;
    }

    return status;
  }

  private resolveErrorHttpStatus(message: string, error?: unknown): HttpStatus {
    if (error instanceof HttpException) {
      return error.getStatus() as HttpStatus;
    }
    if (
      error instanceof UpstreamRequestError &&
      Number.isInteger(error.status) &&
      error.status !== undefined &&
      error.status >= 400 &&
      error.status <= 599
    ) {
      return error.status as HttpStatus;
    }

    const lowered = message.toLowerCase();
    if (lowered.includes('all accounts failed or unhealthy')) {
      return HttpStatus.SERVICE_UNAVAILABLE;
    }
    if (lowered.includes('all accounts exhausted') || lowered.includes('no available accounts')) {
      return HttpStatus.TOO_MANY_REQUESTS;
    }
    if (
      lowered.includes('network socket disconnected') ||
      lowered.includes('secure tls connection was established') ||
      lowered.includes('socket hang up') ||
      lowered.includes('econnreset') ||
      lowered.includes('eai_again')
    ) {
      return HttpStatus.SERVICE_UNAVAILABLE;
    }
    if (lowered.includes('401') || lowered.includes('unauthorized')) {
      return HttpStatus.UNAUTHORIZED;
    }
    if (lowered.includes('403') || lowered.includes('forbidden')) {
      return HttpStatus.FORBIDDEN;
    }
    if (lowered.includes('429') || lowered.includes('rate limit') || lowered.includes('quota')) {
      return HttpStatus.TOO_MANY_REQUESTS;
    }
    if (lowered.includes('503') || lowered.includes('service unavailable')) {
      return HttpStatus.SERVICE_UNAVAILABLE;
    }
    if (lowered.includes('502') || lowered.includes('bad gateway')) {
      return HttpStatus.BAD_GATEWAY;
    }
    if (lowered.includes('504') || lowered.includes('timeout')) {
      return HttpStatus.GATEWAY_TIMEOUT;
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  protected logProxyEndpointError(
    endpoint: string,
    status: HttpStatus,
    message: string,
    error?: unknown,
  ): void {
    const base = `[${endpoint}] status=${status} message=${message}`;
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(base, error instanceof Error ? error.stack : undefined);
      return;
    }
    this.logger.warn(base);
  }
}
