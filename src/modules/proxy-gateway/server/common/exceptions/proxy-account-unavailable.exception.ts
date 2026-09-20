import { HttpException, HttpStatus } from '@nestjs/common';

export class ProxyAccountUnavailableError extends HttpException {
  readonly retryAfterSeconds?: number;

  constructor(params: {
    status: typeof HttpStatus.TOO_MANY_REQUESTS | typeof HttpStatus.SERVICE_UNAVAILABLE;
    retryAfterSeconds?: number;
    cause?: unknown;
  }) {
    const message =
      params.status === HttpStatus.TOO_MANY_REQUESTS && params.cause instanceof Error
        ? params.cause.message
        : 'All accounts failed or unhealthy';
    super(message, params.status, { cause: params.cause });
    this.retryAfterSeconds = params.retryAfterSeconds;
  }
}
