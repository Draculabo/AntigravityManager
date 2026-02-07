import { describe, it, expect } from 'vitest';
import { sanitizeObject, safeStringifyPacket } from '@/utils/sensitiveDataMasking';

describe('sensitive data masking', () => {
  describe('sanitizeObject', () => {
    it('maschera password', () => {
      expect(sanitizeObject({ password: 'secret123' })).toEqual({ password: '[REDACTED]' });
    });

    it('maschera token e varianti (case-insensitive)', () => {
      expect(sanitizeObject({ token: 'abc' })).toEqual({ token: '[REDACTED]' });
      expect(sanitizeObject({ Authorization: 'Bearer xyz' })).toEqual({
        Authorization: '[REDACTED]',
      });
      expect(sanitizeObject({ api_key: 'key123' })).toEqual({ api_key: '[REDACTED]' });
      expect(sanitizeObject({ refresh_token: 'rt' })).toEqual({ refresh_token: '[REDACTED]' });
    });

    it('maschera chiavi annidate', () => {
      expect(
        sanitizeObject({
          user: { name: 'Alice', password: 'pwd', nested: { token: 't' } },
        }),
      ).toEqual({
        user: { name: 'Alice', password: '[REDACTED]', nested: { token: '[REDACTED]' } },
      });
    });

    it('non maschera chiavi non sensibili', () => {
      expect(sanitizeObject({ name: 'Alice', id: 1 })).toEqual({ name: 'Alice', id: 1 });
    });

    it('gestisce null e undefined', () => {
      expect(sanitizeObject(null)).toBe(null);
      expect(sanitizeObject(undefined)).toBe(undefined);
    });

    it('gestisce array ricorsivamente', () => {
      expect(sanitizeObject([{ password: 'x' }, { name: 'y' }])).toEqual([
        { password: '[REDACTED]' },
        { name: 'y' },
      ]);
    });

    it('gestisce stringa JSON con campi sensibili', () => {
      const json = JSON.stringify({ password: 'hidden' });
      expect(sanitizeObject(json)).toBe(JSON.stringify({ password: '[REDACTED]' }));
    });

    it('lascia stringa non-JSON invariata', () => {
      expect(sanitizeObject('plain text')).toBe('plain text');
    });

    it('gestisce riferimenti circolari senza loop infiniti', () => {
      const circular: Record<string, unknown> = { name: 'a', password: 'secret' };
      circular.self = circular;
      expect(sanitizeObject(circular)).toEqual({
        name: 'a',
        password: '[REDACTED]',
        self: '[Circular]',
      });
    });

    it('maschera session_id, cookie, client_secret, otp, pin', () => {
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
    it('stringifica con campi sensibili mascherati', () => {
      const out = safeStringifyPacket({ user: 'a', password: 'p' });
      expect(out).toContain('"user":"a"');
      expect(out).toContain('"password":"[REDACTED]"');
      expect(() => JSON.parse(out)).not.toThrow();
    });
  });
});
