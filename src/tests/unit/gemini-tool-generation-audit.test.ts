import axios from 'axios';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => ({
  beginAttemptSse: vi.fn(),
  completeAttempt: vi.fn(),
  finish: vi.fn(),
  write: vi.fn((_chunk: string) => true),
}));
vi.mock('@/modules/proxy-gateway/audit/traffic-audit.service', () => ({
  trafficAuditService: audit,
}));
vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<
    typeof import('@/server/gateway/common/utils/request-user-agent')
  >()),
  resolveRequestUserAgent: async () => 'tool-generation-audit-test',
}));

import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';
import { MALFORMED_FUNCTION_CALL_RECOVERY_TEXT } from '@/modules/proxy-gateway/antigravity/GeminiFinishReason';
import { toolCallGenerationDiagnostic } from '@/modules/proxy-gateway/audit/tool-call-generation-diagnostic';
import { Upstream4xxCaptureService } from '@/server/gateway/common/upstream-4xx-capture.service';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';

const request: GeminiInternalRequest = {
  model: 'gemini-3-flash',
  project: 'test-project',
  requestId: 'test-request',
  requestType: 'agent',
  userAgent: 'test',
  request: { contents: [{ role: 'user', parts: [{ text: 'Protocol probe.' }] }] },
};
const payload = {
  response: {
    candidates: [
      {
        content: {
          parts: [
            { functionCall: { name: 'valid_previous_tool', args: { api_key: 'fixture-secret' } } },
          ],
        },
        finishReason: 'MALFORMED_FUNCTION_CALL',
      },
    ],
  },
};
const diagnostic = `MALFORMED_FUNCTION_CALL: ${MALFORMED_FUNCTION_CALL_RECOVERY_TEXT}`;

describe('upstream malformed tool generation audit', () => {
  beforeEach(() => {
    audit.completeAttempt.mockClear();
    audit.write.mockClear();
    audit.finish.mockClear();
    audit.beginAttemptSse.mockReturnValue({ write: audit.write, finish: audit.finish });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records a unary generation warning without retrying or changing transport completion', async () => {
    const post = vi
      .spyOn(axios, 'post')
      .mockResolvedValue({ data: payload, headers: {}, status: 200 });
    const client = new GeminiClient(new Upstream4xxCaptureService());
    expect(await client.generateInternal(request, 'fixture-token')).toEqual(payload.response);
    expect(post).toHaveBeenCalledTimes(1);
    expect(audit.completeAttempt).toHaveBeenCalledExactlyOnceWith(null, {
      error: diagnostic,
      outcome: 'completed',
      partial: false,
      responseBody: payload,
      responseHeaders: {},
      status: 200,
      timing: {
        version: 1,
        uploadFinishedMs: null,
        responseHeadersMs: null,
        firstByteMs: null,
        firstUsableOutputMs: null,
      },
      usage: undefined,
    });
  });

  it('captures a split SSE warning in the sanitized body and retains normal completion', async () => {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    const source = Readable.from([Buffer.from(data.slice(0, 31)), Buffer.from(data.slice(31))]);
    const post = vi
      .spyOn(axios, 'post')
      .mockResolvedValue({ data: source, headers: {}, status: 200 });
    const client = new GeminiClient(new Upstream4xxCaptureService());
    const stream = await client.streamGenerateInternal(request, 'fixture-token');
    const received: Buffer[] = [];
    for await (const chunk of stream) {
      received.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(received).toString()).toBe(data);
    expect(post).toHaveBeenCalledTimes(1);
    expect(audit.finish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        errorSummary: diagnostic,
        partial: false,
        terminalStatus: 'completed',
      }),
    );
    expect(audit.completeAttempt).toHaveBeenCalledExactlyOnceWith(null, {
      error: diagnostic,
      outcome: 'completed',
      partial: false,
      responsePayloadHandled: true,
      responseHeaders: {},
      status: 200,
      timing: {
        version: 1,
        uploadFinishedMs: null,
        responseHeadersMs: null,
        firstByteMs: expect.any(Number),
        firstUsableOutputMs: expect.any(Number),
      },
      usage: undefined,
    });
    const captured = audit.write.mock.calls.map((call) => call[0]).join('');
    expect(captured).toContain('MALFORMED_FUNCTION_CALL');
    expect(captured).not.toContain('fixture-secret');
    expect(diagnostic).not.toContain('valid_previous_tool');
  });

  it.each([
    null,
    {},
    {
      candidates: [
        { content: { parts: [{ text: 'MALFORMED_FUNCTION_CALL' }] }, finishReason: 'STOP' },
      ],
    },
    { candidates: [{ finishReason: 1 }] },
  ])('does not mistake text or invalid payloads for a generation failure (%j)', (value) => {
    expect(toolCallGenerationDiagnostic(value)).toBeUndefined();
  });
});
