import { describe, it, expect } from 'vitest';
import { sanitizeObject, safeStringifyPacket } from '@/shared/security/sensitiveDataMasking';

describe('sensitive data masking', () => {
  describe('sanitizeObject', () => {
    it('masks password', () => {
      expect(sanitizeObject({ password: 'secret123' })).toEqual({ password: '[REDACTED]' });
    });

    it('masks token and variants (case-insensitive)', () => {
      expect(sanitizeObject({ token: 'abc' })).toEqual({ token: '[REDACTED]' });
      expect(sanitizeObject({ Authorization: 'Bearer xyz' })).toEqual({
        Authorization: '[REDACTED]',
      });
      expect(sanitizeObject({ api_key: 'key123' })).toEqual({ api_key: '[REDACTED]' });
      expect(sanitizeObject({ refresh_token: 'rt' })).toEqual({ refresh_token: '[REDACTED]' });
    });

    it('masks nested keys', () => {
      expect(
        sanitizeObject({
          user: { name: 'Alice', password: 'pwd', nested: { token: 't' } },
        }),
      ).toEqual({
        user: { name: 'Alice', password: '[REDACTED]', nested: { token: '[REDACTED]' } },
      });
    });

    it('does not mask non-sensitive keys', () => {
      expect(sanitizeObject({ name: 'Alice', id: 1 })).toEqual({ name: 'Alice', id: 1 });
    });

    it('handles null and undefined', () => {
      expect(sanitizeObject(null)).toBe(null);
      expect(sanitizeObject(undefined)).toBe(undefined);
    });

    it('handles arrays recursively', () => {
      expect(sanitizeObject([{ password: 'x' }, { name: 'y' }])).toEqual([
        { password: '[REDACTED]' },
        { name: 'y' },
      ]);
    });

    it('handles JSON string with sensitive fields', () => {
      const json = JSON.stringify({ password: 'hidden' });
      expect(sanitizeObject(json)).toBe(JSON.stringify({ password: '[REDACTED]' }));
    });

    it('leaves non-JSON string unchanged', () => {
      expect(sanitizeObject('plain text')).toBe('plain text');
    });

    it('leaves malformed JSON string unchanged (no throw)', () => {
      expect(sanitizeObject('{"broken":')).toBe('{"broken":');
      expect(sanitizeObject('not valid json ]')).toBe('not valid json ]');
    });

    it('redacts credentials embedded in logged proxy URLs', () => {
      expect(
        sanitizeObject(
          'http=http://alice:secret@proxy.example:8080 https=socks5://bob:p%40ss@proxy.example:1080',
        ),
      ).toBe(
        'http=http://[REDACTED]@proxy.example:8080 https=socks5://[REDACTED]@proxy.example:1080',
      );
    });

    it('redacts proxy URL credentials containing a raw at sign', () => {
      expect(sanitizeObject('proxy=socks5://alice:secr@et@proxy.example:1080')).toBe(
        'proxy=socks5://[REDACTED]@proxy.example:1080',
      );
    });

    it('preserves URLs that do not contain userinfo', () => {
      expect(sanitizeObject('proxy=https://proxy.example:8443/path')).toBe(
        'proxy=https://proxy.example:8443/path',
      );
    });

    it('redacts inline image data URLs while preserving safe metadata', () => {
      const raw = `prefix data:image/png;base64,${'QUJD'.repeat(160)} suffix`;
      const sanitized = sanitizeObject(raw);

      expect(sanitized).toContain('[data URL redacted mime=image/png bytes=480]');
      expect(sanitized).not.toContain('QUJDQUJD');
    });

    it('redacts inlineData base64 while preserving its MIME type', () => {
      const sanitized = sanitizeObject({
        inlineData: {
          mimeType: 'image/webp',
          data: 'QUJD'.repeat(160),
        },
      });

      expect(sanitized).toEqual({
        inlineData: {
          mimeType: 'image/webp',
          data: '[base64 redacted mime=image/webp bytes=480]',
        },
      });
    });

    it('redacts OpenAI b64_json image responses even when the fixture is short', () => {
      expect(
        sanitizeObject({
          data: [{ b64_json: 'QUJDRA==' }],
        }),
      ).toEqual({
        data: [{ b64_json: '[base64 redacted bytes=4]' }],
      });
    });

    it('handles circular references without infinite loops', () => {
      const circular: Record<string, unknown> = { name: 'a', password: 'secret' };
      circular.self = circular;
      expect(sanitizeObject(circular)).toEqual({
        name: 'a',
        password: '[REDACTED]',
        self: '[Circular]',
      });
    });

    it('masks session_id, cookie, client_secret, otp, pin', () => {
      expect(
        sanitizeObject({
          session_id: 'sess',
          cookie: 'c',
          client_secret: 'cs',
          otp: '1234',
          pin: '0000',
        }),
      ).toEqual({
        session_id: '[REDACTED]',
        cookie: '[REDACTED]',
        client_secret: '[REDACTED]',
        otp: '[REDACTED]',
        pin: '[REDACTED]',
      });
    });
  });

  describe('safeStringifyPacket', () => {
    it('stringifies with sensitive fields masked', () => {
      const out = safeStringifyPacket({ user: 'a', password: 'p' });
      expect(out).toContain('"user":"a"');
      expect(out).toContain('"password":"[REDACTED]"');
      expect(() => JSON.parse(out)).not.toThrow();
    });
  });
});
