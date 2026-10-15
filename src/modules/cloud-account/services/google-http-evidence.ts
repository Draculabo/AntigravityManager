import { ClientRequest } from 'node:http';
import { isIP } from 'node:net';
import { TLSSocket } from 'node:tls';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { AxiosResponse } from 'axios';
import type { HttpResponseEvidence } from '@/shared/observability/operationDiagnostic';

/** Observe the final Node connection, not configured proxy intent or an untrusted Server header. */
export function readHttpResponseEvidence(
  response: AxiosResponse<unknown>,
): HttpResponseEvidence | undefined {
  const request: unknown = response.request;
  if (!(request instanceof ClientRequest)) {
    return undefined;
  }
  // The socket peer can be gone once Axios buffers a connection-close response.
  // Classify the native request destination, without claiming a resolved peer or response origin.
  const tunnel =
    'agent' in request && request.agent instanceof HttpsProxyAgent ? request.agent : undefined;
  const host = (tunnel ? tunnel.proxy.hostname : request.host).replace(/^\[|\]$/g, '');
  const contentType: unknown = response.headers['content-type'];
  const mediaType =
    typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : '';
  let responseFormat: HttpResponseEvidence['responseFormat'];
  if (response.data === '' || response.data === null || response.data === undefined) {
    responseFormat = 'empty';
  } else if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
    responseFormat = 'json';
  } else if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
    responseFormat = 'html';
  } else if (mediaType.startsWith('text/')) {
    responseFormat = 'text';
  } else {
    responseFormat = 'other';
  }
  return {
    route: tunnel
      ? 'https-connect'
      : /^https?:\/\//i.test(request.path)
        ? 'forward-proxy'
        : request.path.startsWith('/')
          ? 'origin'
          : 'unknown',
    destination: !isIP(host)
      ? 'unknown'
      : host === '::1' || host.startsWith('127.') || host.startsWith('::ffff:127.')
        ? 'loopback'
        : 'non-loopback',
    transport:
      request.socket instanceof TLSSocket ? 'tls' : !request.socket || tunnel ? 'unknown' : 'plain',
    responseFormat,
  };
}
