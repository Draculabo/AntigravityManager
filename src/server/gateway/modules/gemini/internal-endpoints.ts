import { UpstreamEndpointConfigurationError } from '../../common/exceptions/upstream-endpoint-configuration.exception';

const DEFAULT_INTERNAL_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal',
  'https://cloudcode-pa.googleapis.com/v1internal',
] as const;

/** Decode the operator's endpoint override once per execution, before any physical send. */
export function resolveInternalEndpoints(configured: string | undefined): string[] {
  if (configured === undefined) {
    return [...DEFAULT_INTERNAL_ENDPOINTS];
  }
  if (Buffer.byteLength(configured, 'utf8') > 8192) {
    throw new UpstreamEndpointConfigurationError();
  }
  if (configured.trim() === '') {
    return [...DEFAULT_INTERNAL_ENDPOINTS];
  }
  for (const character of configured) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || character === '\\') {
      throw new UpstreamEndpointConfigurationError();
    }
  }
  const candidates = configured.split(',');
  if (candidates.length > 8) {
    throw new UpstreamEndpointConfigurationError();
  }

  const endpoints = new Set<string>();
  for (const candidate of candidates) {
    if (!/^https?:\/\//iu.test(candidate.trim())) {
      throw new UpstreamEndpointConfigurationError();
    }
    let url: URL;
    try {
      url = new URL(candidate.trim());
    } catch {
      // URL parser errors can embed credentials; report only the fixed routing contract.
      throw new UpstreamEndpointConfigurationError();
    }
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.href.includes('?') ||
      url.href.includes('#')
    ) {
      throw new UpstreamEndpointConfigurationError();
    }
    endpoints.add(url.pathname === '/' ? url.href : url.href.replace(/\/+$/, ''));
  }
  return [...endpoints];
}
