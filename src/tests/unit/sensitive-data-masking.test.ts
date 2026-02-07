import { describe, it, expect } from 'vitest';
import { sanitizeObject, safeStringifyPacket } from '@/utils/sensitiveDataMasking';

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
