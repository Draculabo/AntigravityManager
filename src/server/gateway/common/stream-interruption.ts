import { HttpException } from '@nestjs/common';
import { isTerminalGenerationFailure } from '../../../modules/proxy-gateway/antigravity/UpstreamGenerationError';
import { classifyTransportError } from '../../../modules/proxy-gateway/antigravity/stream-error-utils';
import { GenerationDeadlineExceededError } from './exceptions/generation-deadline.exception';
import { UpstreamRequestError } from './exceptions/upstream-request.exception';

/** Provider/protocol failures and caller cancellation must never authorize a truncation finish. */
export function isUpstreamStreamInterruption(cause: unknown): boolean {
  if (
    !(cause instanceof Error) ||
    cause instanceof HttpException ||
    cause instanceof GenerationDeadlineExceededError ||
    isTerminalGenerationFailure(cause)
  ) {
    return false;
  }
  if (cause instanceof UpstreamRequestError) {
    return (
      cause.status === undefined &&
      cause.transportFailure !== undefined &&
      cause.transportFailure !== 'cancelled'
    );
  }
  const failure = classifyTransportError(cause);
  return failure !== undefined && failure !== 'cancelled';
}
