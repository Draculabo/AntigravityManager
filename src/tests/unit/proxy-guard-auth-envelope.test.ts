import type { ExecutionContext } from '@nestjs/common';
import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';

const credentialMocks = vi.hoisted(() => ({
  matches: vi.fn(),
}));

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: credentialMocks,
}));

vi.mock('@/server/server-config', () => ({
  getServerConfig: () => ({ api_key: 'configured-api-key' }),
}));

function createContext(url: string, headers: Record<string, string> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers, ip: '127.0.0.1', url }),
    }),
  } as ExecutionContext;
}

function rejectionBody(context: ExecutionContext): unknown {
  try {
    new ProxyGuard().canActivate(context);
    throw new Error('expected canActivate to reject the request');
  } catch (error) {
    expect(error).toBeInstanceOf(UnauthorizedException);
    const unauthorized = error as UnauthorizedException;
    expect(unauthorized.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    return unauthorized.getResponse();
  }
}

describe('ProxyGuard auth rejection envelope', () => {
  beforeEach(() => {
    credentialMocks.matches.mockReset();
    credentialMocks.matches.mockReturnValue(false);
  });

  it('answers an OpenAI caller in the shape its SDK parses', () => {
    expect(rejectionBody(createContext('/v1/chat/completions'))).toEqual({
      error: {
        code: 'invalid_api_key',
        message: 'API key validation failed',
        param: null,
        type: 'invalid_request_error',
      },
    });
  });

  it('answers an OpenAI caller the same way when the key is merely wrong', () => {
    expect(
      rejectionBody(createContext('/v1/chat/completions', { authorization: 'Bearer sk-wrong' })),
    ).toEqual({
      error: {
        code: 'invalid_api_key',
        message: 'API key validation failed',
        param: null,
        type: 'invalid_request_error',
      },
    });
  });

  it('answers an Anthropic caller in the shape its SDK parses', () => {
    expect(rejectionBody(createContext('/v1/messages'))).toEqual({
      error: { message: 'API key validation failed', type: 'authentication_error' },
      type: 'error',
    });
  });

  it('answers a Gemini caller in the shape its SDK parses', () => {
    expect(rejectionBody(createContext('/v1beta/models/gemini-3-pro:generateContent'))).toEqual({
      error: { code: 401, message: 'API key validation failed', status: 'UNAUTHENTICATED' },
    });
  });

  it('reads the anthropic-version header on a path the two surfaces share', () => {
    expect(
      rejectionBody(createContext('/v1/models', { 'anthropic-version': '2023-06-01' })),
    ).toEqual({
      error: { message: 'API key validation failed', type: 'authentication_error' },
      type: 'error',
    });
  });

  it('keeps the message silent about why the key failed', () => {
    const body = rejectionBody(
      createContext('/v1/chat/completions', { authorization: 'Bearer sk-wrong' }),
    );

    expect(JSON.stringify(body)).not.toMatch(/configured-api-key|sk-wrong/u);
  });
});
