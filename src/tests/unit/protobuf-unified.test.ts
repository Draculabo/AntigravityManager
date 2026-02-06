import { describe, it, expect } from 'vitest';
import { ProtobufUtils } from '../../utils/protobuf';

describe('ProtobufUtils Unified OAuth', () => {
  it('should round-trip OAuthInfo payload', () => {
    const accessToken = 'access-token-123';
    const refreshToken = 'refresh-token-456';
    const expiry = 1700000000;

    const oauthInfo = ProtobufUtils.createOAuthInfo(accessToken, refreshToken, expiry);
    const parsed = ProtobufUtils.extractOAuthTokenInfoFromOAuthInfo(oauthInfo);

    expect(parsed).toEqual({
      accessToken,
      refreshToken,
    });
  });

  it('should round-trip unified oauth token', () => {
    const accessToken = 'access-token-abc';
    const refreshToken = 'refresh-token-def';
    const expiry = 1700001234;

    const unifiedB64 = ProtobufUtils.createUnifiedOAuthToken(
      accessToken,
      refreshToken,
      expiry,
    );
    const unifiedBytes = new Uint8Array(Buffer.from(unifiedB64, 'base64'));
    const parsed = ProtobufUtils.extractOAuthTokenInfoFromUnifiedState(unifiedBytes);

    expect(parsed).toEqual({
      accessToken,
      refreshToken,
    });
  });
});
