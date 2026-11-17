import { HttpException, HttpStatus } from '@nestjs/common';

export class ProxyAccountUnavailableError extends HttpException {
  readonly retryAfterSeconds?: number;

  constructor(params: {
    status: typeof HttpStatus.TOO_MANY_REQUESTS | typeof HttpStatus.SERVICE_UNAVAILABLE;
    retryAfterSeconds?: number;
    cause?: unknown;
  }) {
    let message = 'All accounts failed or unhealthy';
    if (params.status === HttpStatus.TOO_MANY_REQUESTS) {
      message =
        params.cause instanceof Error ? params.cause.message : 'All available accounts are rate limited';
    }
    super(message, params.status, { cause: params.cause });
    this.retryAfterSeconds = params.retryAfterSeconds;
  }
}
