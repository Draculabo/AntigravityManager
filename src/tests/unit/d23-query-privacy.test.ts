import { describe, expect, it } from 'vitest';
import {
  sanitizeAuditUrl,
  serializeAuditQuery,
  snapshotAuditPayload,
} from '@/modules/proxy-gateway/audit/audit-sanitizer';
import { redactDiagnosticText } from '@/shared/observability/sentryPrivacy';

describe('query credential privacy', () => {
  it('redacts duplicate and encoded query key names while retaining unrelated query values', () => {
    const url = sanitizeAuditUrl(
      '/v1beta/models?key=first-secret&k%65y=second-secret&client=desktop&alt=sse',
    );
    const params = new URL(url, 'http://local.test').searchParams;
    expect([...params]).toEqual([
      ['key', '[REDACTED]'],
      ['client', 'desktop'],
      ['alt', 'sse'],
    ]);
    expect(url).not.toMatch(/first-secret|second-secret/);
  });

  it('does not redact ordinary JSON payload fields named key', () => {
    const value = { key: 'orchid-record', nested: { key: 'column-name' }, api_key: 'credential' };
    expect(snapshotAuditPayload(value).text).toBe(
      JSON.stringify({
        key: 'orchid-record',
        nested: { key: 'column-name' },
        api_key: '[REDACTED]',
      }),
    );
  });

  it('redacts query-object keys before JSON storage and raw or JSON historical readback', () => {
    const query = { key: ['first-secret', 'second-secret'], alt: 'sse', count: 2 };
    const expected = JSON.stringify({ key: '[REDACTED]', alt: 'sse', count: 2 });
    expect(serializeAuditQuery(query)).toBe(expected);
    expect(serializeAuditQuery(JSON.stringify(query))).toBe(expected);
    expect(serializeAuditQuery('key=first-secret&k%65y=second-secret&alt=sse')).toBe(
      'key=%5BREDACTED%5D&alt=sse',
    );
    expect(query).toEqual({ key: ['first-secret', 'second-secret'], alt: 'sse', count: 2 });
  });

  it('redacts URL credentials with percent-encoded parameter names in diagnostic text', () => {
    expect(
      redactDiagnosticText(
        'GET /v1beta/models?k%65y=first-secret&%6b%65%79=second-secret&alt=sse failed',
      ),
    ).toBe('GET /v1beta/models?k%65y=[REDACTED]&%6b%65%79=[REDACTED]&alt=sse failed');
    expect(redactDiagnosticText('ordinary key=orchid-record')).toBe('ordinary key=orchid-record');
    expect(
      snapshotAuditPayload({ message: 'GET /v1beta/models?k%65y=first-secret failed' }).text,
    ).toBe(JSON.stringify({ message: 'GET /v1beta/models?k%65y=[REDACTED] failed' }));
  });
});
