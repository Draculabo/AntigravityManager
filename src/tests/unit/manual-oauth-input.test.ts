import { describe, expect, it } from 'vitest';
import { DesktopOAuthCodeInputSchema } from '@/modules/cloud-account/services/desktop-oauth-login.schema';
import {
  InvalidManualOAuthInputError,
  parseManualOAuthInput,
} from '@/modules/cloud-account/services/manual-oauth-input';
import { OAuthCompleteRequestSchema } from '@/core/management/protocol';

describe('manual OAuth input boundary', () => {
  it('admits a bounded complete callback address without parsing away its state', () => {
    const input = {
      code: 'http://127.0.0.1:12345/oauth-callback?code=4%2Ftest&state=session-state',
    };
    expect(DesktopOAuthCodeInputSchema.parse(input)).toEqual(input);
  });

  it('keeps desktop and Core completion transport on the same bounded text contract', () => {
    const input = { code: '?code=4%2Ftest&state=current' };
    expect(OAuthCompleteRequestSchema.parse(input)).toEqual(
      DesktopOAuthCodeInputSchema.parse(input),
    );
    expect(OAuthCompleteRequestSchema.safeParse({ code: 'x'.repeat(2049) }).success).toBe(false);
    expect(DesktopOAuthCodeInputSchema.safeParse({ code: ' ' }).success).toBe(false);
  });

  it.each([
    [' 4/raw+code ', { kind: 'code', code: '4/raw+code' }],
    ['4%2Fencoded%2Bcode', { kind: 'code', code: '4/encoded+code' }],
    [
      'http://127.0.0.1:1234/oauth-callback?code=4%2Fcode&state=current',
      { kind: 'callback', code: '4/code', state: 'current' },
    ],
    [
      'https://example.invalid/callback?code=4%2Fcode&state=current&scope=email',
      { kind: 'callback', code: '4/code', state: 'current' },
    ],
    [
      'localhost:1234/oauth-callback?state=current&code=4%2Fcode',
      { kind: 'callback', code: '4/code', state: 'current' },
    ],
    [
      '127.0.0.1:1234/oauth-callback?code=4%2Fcode&state=current',
      { kind: 'callback', code: '4/code', state: 'current' },
    ],
    [
      '[::1]:1234/oauth-callback?code=4%2Fcode&state=current',
      { kind: 'callback', code: '4/code', state: 'current' },
    ],
    [
      '?code=4%2Fcode%2Bpart&state=current',
      { kind: 'callback', code: '4/code+part', state: 'current' },
    ],
    ['state=current&code=4%2Fcode', { kind: 'callback', code: '4/code', state: 'current' }],
    ['?error=access_denied&state=current', { kind: 'denied', state: 'current' }],
  ])('parses %s without losing code or state', (input, expected) => {
    expect(parseManualOAuthInput(input)).toEqual(expected);
  });

  it.each([
    '',
    ' ',
    '4%ZZ',
    '4%FF',
    '4%252Fdouble',
    '4/code#fragment',
    '4/code&field=value',
    '?code=4/code',
    '?code=4/code&state=',
    '?code=4/code&state=x&state=x',
    '?code=4/code&code=4/other&state=x',
    '?code=4/code&state=x&%73tate=x',
    '?error=access_denied&state=x&code=4/code',
    '?error=access_denied&state=x&error=access_denied',
    '?error=unknown&state=x',
    '?state=x',
    '?code=4%FF&state=x',
    '?code=4/code+part&state=x',
    '?code=4/code&state=x#truncated',
    'http://127.0.0.1/callback?code=4/code&state=x#fragment',
    'http://user:password@localhost/callback?code=4/code&state=x',
    'http://bad host/?code=4/code&state=x',
    'javascript:code=4/code&state=x',
    '4/raw\ncode',
  ])('rejects ambiguous or malformed input without reflecting it: %s', (input) => {
    try {
      parseManualOAuthInput(input);
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidManualOAuthInputError);
      expect(error).toMatchObject({ message: 'Invalid OAuth completion input' });
    }
  });
});
