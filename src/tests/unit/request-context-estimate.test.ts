import { describe, expect, it } from 'vitest';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';
import { estimateRequestContext } from '@/server/gateway/common/request-context-estimate';

function request(): GeminiInternalRequest {
  return {
    model: 'synthetic-model',
    requestId: 'synthetic-request',
    userAgent: 'test',
    request: {
      systemInstruction: { parts: [{ text: 'sys' }] },
      tools: [{ googleSearch: {} }],
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'abcd' },
            { text: '你好' },
            { inlineData: { mimeType: 'image/png', data: 'AQ==' } },
            { inlineData: { mimeType: 'audio/wav', data: 'AQ==' } },
            { inlineData: { mimeType: 'audio/mpeg', data: 'AQ==' } },
            { inlineData: { mimeType: 'application/pdf', data: 'AQ==' } },
            { fileData: { mimeType: 'video/mp4', fileUri: 'https://example.invalid/video' } },
          ],
        },
        {
          role: 'model',
          parts: [
            { thought: true, text: 'reason', thoughtSignature: 's'.repeat(60) },
            { functionCall: { name: 'read', args: { path: 'x' } } },
            { functionResponse: { name: 'read', response: { output: 'ok' } } },
          ],
        },
      ],
    },
  };
}

describe('complete request context estimate', () => {
  it('counts system, tools, history, restored thoughts and media without rewriting input', () => {
    const body = request();
    const original = structuredClone(body);
    expect(estimateRequestContext(body)).toEqual({
      algorithmVersion: 2,
      estimatedInputTokens: 415,
      systemTokens: 1,
      textTokens: 4,
      toolTokens: 44,
      thoughtMetadataTokens: 100,
      mediaTokens: 258,
      messageOverheadTokens: 8,
      signatureCharacters: 60,
      inlineMediaBytes: 4,
      unestimatedMediaParts: 4,
      messages: 2,
    });
    expect(body).toEqual(original);
  });

  it('includes entire nested tool schemas and tool response values', () => {
    const body = request();
    body.request.tools = [
      {
        functionDeclarations: [
          {
            name: 'read',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string', description: 'x'.repeat(4000) } },
            },
          },
        ],
      },
    ];
    body.request.contents[1].parts[2].functionResponse!.response.output = 'x'.repeat(4000);
    const estimate = estimateRequestContext(body);
    expect(estimate.toolTokens).toBeGreaterThan(2000);
    expect(estimate.textTokens).toBe(4);
  });

  it('includes camel-case and snake-case tool configuration', () => {
    const body = request();
    body.request.tools = [];
    body.request.contents = [];
    body.request.toolConfig = {
      functionCallingConfig: {
        allowedFunctionNames: ['camel_' + 'x'.repeat(8000)],
        mode: 'ANY',
      },
    };
    const camelCase = estimateRequestContext(body);

    body.request.toolConfig = undefined;
    body.request.tool_config = {
      function_calling_config: {
        allowed_function_names: ['snake_' + 'x'.repeat(8000)],
        mode: 'ANY',
      },
    };
    const snakeCase = estimateRequestContext(body);

    expect(camelCase.toolTokens).toBeGreaterThan(2000);
    expect(snakeCase.toolTokens).toBeGreaterThan(2000);
  });

  it('does not count routing envelopes or output reservations as model input', () => {
    const body = request();
    const estimate = estimateRequestContext(body);
    body.project = 'x'.repeat(4000);
    body.requestId = 'x'.repeat(4000);
    body.request.generationConfig = {
      maxOutputTokens: 65535,
      thinkingConfig: {
        thinkingBudget: 24576,
        includeThoughts: true,
      },
    };
    expect(estimateRequestContext(body)).toEqual(estimate);
  });

  it('treats base64 as media size, and reports documents and remote media as unestimated', () => {
    const body = request();
    body.request.contents = [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: 'AAAA'.repeat(100_000) } },
          { inlineData: { mimeType: 'application/pdf', data: 'AAAA'.repeat(100_000) } },
          { fileData: { mimeType: 'audio/mp3', fileUri: 'https://example.invalid/audio' } },
        ],
      },
    ];
    expect(estimateRequestContext(body)).toEqual({
      algorithmVersion: 2,
      estimatedInputTokens: 268,
      systemTokens: 1,
      textTokens: 0,
      toolTokens: 5,
      thoughtMetadataTokens: 0,
      mediaTokens: 258,
      messageOverheadTokens: 4,
      signatureCharacters: 0,
      inlineMediaBytes: 600_000,
      unestimatedMediaParts: 2,
      messages: 1,
    });
  });

  it('counts snake-case signatures without treating their opaque bytes as prose', () => {
    const body = request();
    body.request.contents = [
      { role: 'model', parts: [{ text: 'abcd', thought_signature: 's'.repeat(6000) }] },
    ];
    const estimate = estimateRequestContext(body);
    expect(estimate.signatureCharacters).toBe(6000);
    expect(estimate.thoughtMetadataTokens).toBe(100);
    expect(estimate.textTokens).toBe(1);
  });
});
