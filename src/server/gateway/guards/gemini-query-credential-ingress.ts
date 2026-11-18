import type { FastifyInstance } from 'fastify';
import { extractApiKeyToken, type RequestHeaders } from './api-key-auth.util';

type GeminiQueryCredential =
  | { kind: 'unchanged' }
  | { kind: 'query'; token: string }
  | { kind: 'invalid' };

/** Query credentials belong only to Gemini; a nonempty Header credential stays authoritative. */
export function readGeminiQueryCredential(
  url: string,
  headers: RequestHeaders,
): GeminiQueryCredential {
  const separator = url.indexOf('?');
  const path = separator === -1 ? url : url.slice(0, separator);
  if (
    !(path.startsWith('/v1beta/') || path.startsWith('/upload/v1beta/')) ||
    separator === -1 ||
    extractApiKeyToken(headers) !== null
  ) {
    return { kind: 'unchanged' };
  }
  const keys = new URLSearchParams(url.slice(separator + 1)).getAll('key');
  if (keys.length > 1) {
    return { kind: 'invalid' };
  }
  const token = keys[0]?.trim();
  return token ? { kind: 'query', token } : { kind: 'unchanged' };
}

/** Register before audit/session hooks so every downstream owner sees the same credential. */
export function registerGeminiQueryCredentialIngress(instance: FastifyInstance): void {
  instance.addHook('onRequest', (request, reply, done) => {
    const credential = readGeminiQueryCredential(request.url, request.headers);
    if (credential.kind === 'invalid') {
      void reply.code(400).send({
        error: {
          code: 400,
          message: 'The key query parameter must occur only once.',
          status: 'INVALID_ARGUMENT',
        },
      });
      return;
    }
    if (credential.kind === 'query') {
      request.headers['x-goog-api-key'] = credential.token;
    }
    done();
  });
}
