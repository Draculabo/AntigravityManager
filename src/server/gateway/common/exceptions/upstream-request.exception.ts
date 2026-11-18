import { isNumber, isObjectLike, isString } from 'lodash-es';
import type { GoogleApiErrorDetail } from '../google-error-details';
import type { UpstreamTransportFailure } from '../../../../modules/proxy-gateway/antigravity/stream-error-utils';
import type { GoogleErrorStatus } from '../upstream-error-codec';

export interface UpstreamErrorHeaders {
  retryAfter?: string;
}

export class UpstreamRequestError extends Error {
  readonly status?: number;
  readonly headers?: UpstreamErrorHeaders;
  readonly body?: string;
  readonly transportFailure?: UpstreamTransportFailure;
  readonly upstreamStatus?: GoogleErrorStatus;
  readonly source?: 'bare' | 'wrapped';
  readonly messageTruncated?: boolean;
  /** The transport matched structured denial to the actual sent body project. */
  readonly projectConsumerDenied?: boolean;
  /**
   * Structured `google.rpc` details captured before `body` was truncated, so a classifier can
   * read them even when the rendered body was clipped to 1000 characters.
   */
  readonly details?: GoogleApiErrorDetail[];

  constructor(params: {
    message: string;
    status?: number;
    headers?: UpstreamErrorHeaders;
    body?: string;
    details?: GoogleApiErrorDetail[];
    transportFailure?: UpstreamTransportFailure;
    upstreamStatus?: GoogleErrorStatus;
    source?: 'bare' | 'wrapped';
    messageTruncated?: boolean;
    projectConsumerDenied?: boolean;
  }) {
    super(params.message);
    this.name = 'UpstreamRequestError';

    if (params.status && !isNumber(params.status)) {
      throw new TypeError('status must be a number');
    }
    if (params.headers && !isObjectLike(params.headers)) {
      throw new TypeError('headers must be an object');
    }

    this.status = params.status;
    this.headers = params.headers;
    this.details = params.details;
    this.transportFailure = params.transportFailure;
    this.upstreamStatus = params.upstreamStatus;
    this.source = params.source;
    this.messageTruncated = params.messageTruncated;
    this.projectConsumerDenied = params.projectConsumerDenied;

    // Sanitize and limit body size
    if (isString(params.body)) {
      const sanitized = params.body.replace(/<[^>]*>?/gm, '');
      this.body = sanitized.substring(0, 1000);
    } else {
      this.body = undefined;
    }
  }
}
