export interface UpstreamErrorHeaders {
  retryAfter?: string;
}

export class UpstreamRequestError extends Error {
  readonly status?: number;
  readonly headers?: UpstreamErrorHeaders;
  readonly body?: string;

  constructor(params: {
    message: string;
    status?: number;
    headers?: UpstreamErrorHeaders;
    body?: string;
  }) {
    super(params.message);
    this.name = 'UpstreamRequestError';

    if (params.status && typeof params.status !== 'number') {
      throw new TypeError('status must be a number');
    }
    if (params.headers && typeof params.headers !== 'object') {
      throw new TypeError('headers must be an object');
    }

    this.status = params.status;
    this.headers = params.headers;

    // Sanitize and limit body size
    if (typeof params.body === 'string') {
      const sanitized = params.body.replace(/<[^>]*>?/gm, '');
      this.body = sanitized.substring(0, 1000);
    } else {
      this.body = undefined;
    }
  }
}
