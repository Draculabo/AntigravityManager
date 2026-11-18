/** Invalid operator routing must not be retried against another endpoint or account. */
export class UpstreamEndpointConfigurationError extends Error {
  constructor() {
    super(
      'Configure up to eight absolute HTTP(S) internal endpoint URLs without credentials, query or fragment (maximum 8 KiB).',
    );
    this.name = 'UpstreamEndpointConfigurationError';
  }
}
