import http from 'node:http';
import axios from 'axios';
import { describe, expect, it } from 'vitest';
import { readHttpResponseEvidence } from '@/modules/cloud-account/services/google-http-evidence';
import { HttpResponseEvidenceSchema } from '@/shared/observability/operationDiagnostic';

describe('Google HTTP connection evidence', () => {
  it('observes a real origin-form request without retaining its URL, headers or response text', async () => {
    const server = http.createServer((request, response) => {
      request.resume();
      response.writeHead(502, { 'content-type': 'text/plain', server: 'private-sentinel' });
      response.end('private-sentinel');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Synthetic origin has no port');
    }
    try {
      const response = await axios.get<unknown>(
        `http://127.0.0.1:${address.port}/private-sentinel`,
        { adapter: 'http', proxy: false, validateStatus: () => true },
      );
      const evidence = readHttpResponseEvidence(response);
      expect(evidence).toEqual({
        route: 'origin',
        destination: 'loopback',
        transport: 'plain',
        responseFormat: 'text',
      });
      expect(
        HttpResponseEvidenceSchema.safeParse({ ...evidence, address: 'private-sentinel' }).success,
      ).toBe(false);
      delete response.request;
      expect(readHttpResponseEvidence(response)).toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
