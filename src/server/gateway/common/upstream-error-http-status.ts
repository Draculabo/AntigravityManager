import { HttpStatus } from '@nestjs/common';
import { UnsupportedGeminiFinishReasonError } from '../../../modules/proxy-gateway/antigravity/GeminiFinishReason';
import { UpstreamGenerationError } from '../../../modules/proxy-gateway/antigravity/UpstreamGenerationError';
import {
  classifyTransportError,
  type UpstreamTransportFailure,
} from '../../../modules/proxy-gateway/antigravity/stream-error-utils';
import { UpstreamRequestError } from './exceptions/upstream-request.exception';

function transportStatus(failure: UpstreamTransportFailure | undefined): HttpStatus | undefined {
  if (failure === 'timeout') {
    return HttpStatus.GATEWAY_TIMEOUT;
  }
  if (failure === 'cancelled') {
    // Keep the existing local cancellation status, independently of timeout wording.
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }
  return failure ? HttpStatus.BAD_GATEWAY : undefined;
}

/** Projects known provider failures without interpreting provider messages as HTTP statuses. */
export function resolveUpstreamErrorHttpStatus(error: unknown): HttpStatus | undefined {
  if (
    error instanceof UnsupportedGeminiFinishReasonError ||
    error instanceof UpstreamGenerationError
  ) {
    return HttpStatus.BAD_GATEWAY;
  }
  if (error instanceof UpstreamRequestError) {
    if (error.status !== undefined) {
      return Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
        ? (error.status as HttpStatus)
        : HttpStatus.BAD_GATEWAY;
    }
    return transportStatus(error.transportFailure) ?? HttpStatus.BAD_GATEWAY;
  }
  return error instanceof Error ? transportStatus(classifyTransportError(error)) : undefined;
}
