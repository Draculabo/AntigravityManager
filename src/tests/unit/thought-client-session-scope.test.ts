import { expect, it } from 'vitest';
import {
  createThoughtSessionKey,
  resolveThoughtSession,
} from '@/modules/proxy-gateway/audit/traffic-audit-http-metadata';

it('preserves distinct Unicode/case/punctuation client identities and normalizes equivalent caller credentials', () => {
  const headers = { authorization: 'Bearer synthetic-caller' };
  expect(createThoughtSessionKey(headers, '会话甲')).not.toBe(
    createThoughtSessionKey(headers, '会话乙'),
  );
  expect(createThoughtSessionKey(headers, 'Case.A')).not.toBe(
    createThoughtSessionKey(headers, 'case.A'),
  );
  expect(createThoughtSessionKey(headers, 'same/id')).not.toBe(
    createThoughtSessionKey(headers, 'same_id'),
  );
  expect(createThoughtSessionKey(headers, 'client')).toBe(
    createThoughtSessionKey({ 'x-api-key': 'synthetic-caller' }, 'client'),
  );
  expect(createThoughtSessionKey(headers, 'client')).not.toBe(
    createThoughtSessionKey({ authorization: 'Bearer another-caller' }, 'client'),
  );
});

it('uses D03 hint priority and never promotes an unverified response cursor', () => {
  const request = {
    headers: { 'x-claude-code-session-id': 'winner', 'x-session-id': 'loser' },
    url: '/v1/responses?session_id=query',
    body: { session_id: 'body' },
  };
  expect(resolveThoughtSession(request).key).toBe(
    createThoughtSessionKey(request.headers, 'winner'),
  );
  const noHint = resolveThoughtSession({
    headers: {},
    url: '/v1/responses',
    body: { previous_response_id: 'unverified-cursor' },
  });
  expect(noHint.stable).toBe(false);
  expect(noHint.clientId).not.toBe('unverified-cursor');
});
