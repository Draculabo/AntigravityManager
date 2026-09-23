import { describe, expect, it } from 'vitest';

import { formatCurlRequest } from '@/modules/proxy-gateway/curl-export/format-curl';

describe('traffic cURL export', () => {
  it('quotes a PowerShell request without turning body text into shell syntax', () => {
    expect(
      formatCurlRequest(
        {
          method: 'post',
          url: "http://localhost:8045/v1/responses?name=O'Brien",
          headers: {
            Authorization: 'Bearer sk-test',
            Host: 'localhost:8045',
            'Content-Length': '123',
            'Content-Type': 'application/json',
          },
          body: '{"input":"it\'s $not-a-variable"}',
        },
        'powershell',
      ),
    ).toEqual(
      "curl.exe -X 'POST' 'http://localhost:8045/v1/responses?name=O''Brien' -H 'Authorization: Bearer sk-test' -H 'Content-Type: application/json' --data-raw '{\"input\":\"it''s $not-a-variable\"}'",
    );
  });

  it('quotes POSIX arguments and omits transport headers', () => {
    expect(
      formatCurlRequest(
        {
          method: 'get',
          url: 'http://localhost:8045/v1/models',
          headers: { connection: 'keep-alive', 'X-Test': "a'b" },
        },
        'posix',
      ),
    ).toEqual("curl -X 'GET' 'http://localhost:8045/v1/models' -H 'X-Test: a'\"'\"'b'");
  });

  it('refuses headers with line breaks instead of silently changing the replay', () => {
    expect(() =>
      formatCurlRequest(
        { method: 'GET', url: 'http://localhost:8045/v1/models', headers: { 'X-Test': 'a\nb' } },
        'posix',
      ),
    ).toThrow('line break');
  });
});
