import type { InternalSseError } from '../../../modules/proxy-gateway/antigravity/internal-sse';
import { describeInternalSseError } from '../../../modules/proxy-gateway/antigravity/internal-sse';
import { extractGoogleErrorDetails } from './google-error-details';
import { UpstreamRequestError } from './exceptions/upstream-request.exception';
import { readUpstreamErrorStatus } from './upstream-error-codec';

/** Retain validated provider status across collection/preflight without guessing from prose. */
export function upstreamGenerationFailure(error: InternalSseError): Error {
  return (
    error.cause ??
    new UpstreamRequestError({
      status: error.code,
      message: describeInternalSseError(error),
      details: extractGoogleErrorDetails({ error: { details: error.details } }),
      upstreamStatus: readUpstreamErrorStatus({ error }),
      source: error.source,
      messageTruncated: error.messageTruncated,
    })
  );
}
