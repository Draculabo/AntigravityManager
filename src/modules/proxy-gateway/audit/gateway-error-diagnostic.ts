import { errorProcessOwner } from '@/modules/error-diagnostics/public';
import { UpstreamGenerationError } from '../antigravity/UpstreamGenerationError';
import { classifyTransportError } from '../antigravity/stream-error-utils';

/** Terminal request diagnostics contain correlation and real Error evidence, never bodies. */
export function captureGatewayErrorDiagnostic(input: {
  error: unknown;
  status: number;
  protocol: string;
  requestId?: string;
}): void {
  if (input.error === undefined && input.status < 400) {
    return;
  }
  const error = input.error instanceof Error ? input.error : undefined;
  const category =
    error instanceof UpstreamGenerationError
      ? error.code
      : error
        ? (classifyTransportError(error) ??
          (input.status >= 500 ? 'internal_error' : 'request_error'))
        : input.status === 401 || input.status === 403
          ? 'authorization_failure'
          : input.status === 429
            ? 'rate_limited'
            : input.status >= 500
              ? 'internal_error'
              : 'request_error';
  errorProcessOwner.capture({
    error: error ?? `Gateway request ended with HTTP ${input.status}.`,
    source: 'proxy-gateway',
    module: 'http-completion',
    functionName: 'completeHttpAuditState',
    stage: 'terminal',
    protocol: input.protocol,
    category,
    status: input.status,
    requestId: input.requestId,
  });
}
