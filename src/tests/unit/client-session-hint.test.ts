import { describe, expect, it } from 'vitest';
import { resolveClientSessionHint } from '@/server/gateway/common/client-session-hint';

describe('bounded client session hint selection', () => {
  it('uses the fixed product priority independently of input insertion order', () => {
    const products = [
      'x-claude-code-session-id',
      'x-antigravity-session-id',
      'x-client-session-id',
      'x-cursor-session-id',
      'cursor-session-id',
      'x-vscode-session-id',
      'anthropic-session-id',
    ];
    for (let index = 0; index < products.length; index += 1) {
      const headers = Object.fromEntries(
        products
          .slice(index)
          .reverse()
          .map((name) => [name, name]),
      );
      expect(
        resolveClientSessionHint({
          ...headers,
          'a-custom-session-id': 'generic',
          'x-session-id': 'fallback',
        }),
      ).toEqual({
        id: products[index],
        diagnostics: { source: 'header', field: products[index], invalidCandidates: 0 },
      });
    }
  });
  it('normalizes header names but keeps ID case and punctuation unchanged', () => {
    expect(resolveClientSessionHint({ 'X-Claude-Code-Session-Id': '  A/#:_-中文😀  ' })).toEqual({
      id: 'A/#:_-中文😀',
      diagnostics: { source: 'header', field: 'x-claude-code-session-id', invalidCandidates: 0 },
    });
  });
  it('keeps deterministic generic-header sorting and excludes transport/request identifiers', () => {
    expect(
      resolveClientSessionHint({
        'z-other-session-id': 'z',
        'a-other-session-id': 'a',
        'mcp-session-id': 'mcp',
        'x-request-session-id': 'request',
        'x-trace-session-id': 'trace',
        'x-correlation-session-id': 'correlation',
      }),
    ).toEqual({
      id: 'a',
      diagnostics: { source: 'header', field: 'a-other-session-id', invalidCandidates: 0 },
    });
  });
  it('uses header, query, top-level fields and metadata in that order', () => {
    const url = '/?session_id=query';
    const body = { session_id: 'body' },
      metadata = { session_id: 'meta' };
    expect(resolveClientSessionHint({ 'x-session-id': 'header' }, url, body, metadata).id).toBe(
      'header',
    );
    expect(resolveClientSessionHint({}, url, body, metadata).id).toBe('query');
    expect(resolveClientSessionHint({}, undefined, body, metadata).id).toBe('body');
    expect(resolveClientSessionHint({}, undefined, {}, metadata).id).toBe('meta');
  });
  it.each([
    'x-conversation-id',
    'conversation-id',
    'x-chat-id',
    'chat-id',
    'x-thread-id',
    'thread-id',
  ])('keeps the existing header alias %s', (name) => {
    expect(resolveClientSessionHint({ [name]: 'scope' }).id).toBe('scope');
  });
  it('accepts 128 Unicode points without truncation, rejecting 129 and unpaired surrogates', () => {
    const id = '😀'.repeat(128);
    expect(resolveClientSessionHint({ 'x-session-id': id }).id).toBe(id);
    for (const invalid of ['x'.repeat(129), '😀'.repeat(129), 'a\nb', '\ud800']) {
      expect(
        resolveClientSessionHint({ 'x-claude-code-session-id': invalid, 'x-session-id': 'valid' }),
      ).toEqual({
        id: 'valid',
        diagnostics: { source: 'header', field: 'x-session-id', invalidCandidates: 1 },
      });
    }
  });
  it('rejects repeated header arrays and conflicting case variants, while retaining equal values', () => {
    expect(
      resolveClientSessionHint({ 'x-session-id': ['a', 'a'] }, '/?session_id=fallback').id,
    ).toBe('fallback');
    expect(
      resolveClientSessionHint(
        { 'X-Session-ID': 'a', 'x-session-id': 'b' },
        '/?session_id=fallback',
      ),
    ).toEqual({
      id: 'fallback',
      diagnostics: { source: 'query', field: 'session_id', invalidCandidates: 1 },
    });
    expect(resolveClientSessionHint({ 'X-Session-ID': ' a ', 'x-session-id': 'a' }).id).toBe('a');
  });
  it('rejects ambiguous duplicate query values without merging or dropping characters', () => {
    expect(
      resolveClientSessionHint({}, '/?session_id=a&session_id=b', { session_id: 'body' }),
    ).toEqual({
      id: 'body',
      diagnostics: { source: 'body', field: 'session_id', invalidCandidates: 1 },
    });
    expect(resolveClientSessionHint({}, '/?session_id=a&session_id=a').id).toBe('a');
  });
  it('counts invalid candidates without retaining private hint values in diagnostics', () => {
    const hint = resolveClientSessionHint(
      { 'x-session-id': 'private'.repeat(100) },
      '/?session_id=',
      { session_id: 42 },
      { session_id: null, user_id: 'valid' },
    );
    expect(hint).toEqual({
      id: 'valid',
      diagnostics: { source: 'legacy-user', field: 'user_id', invalidCandidates: 4 },
    });
    expect(JSON.stringify(hint.diagnostics)).not.toMatch(/private|"valid"/);
  });
  it('does not accept response cursors, forwarded URLs or reference headers as session roots', () => {
    expect(
      resolveClientSessionHint(
        {
          referer: 'https://example.test/?session_id=other',
          'x-forwarded-uri': '/?session_id=foreign',
        },
        '/?previous_response_id=cursor',
        { previous_response_id: 'cursor' },
      ),
    ).toEqual({ diagnostics: { source: 'none', invalidCandidates: 0 } });
  });
});
