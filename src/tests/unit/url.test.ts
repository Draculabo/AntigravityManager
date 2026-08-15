import { describe, expect, it } from 'vitest';
import { isValidProxyUrl } from '../../shared/utils/url';

describe('isValidProxyUrl', () => {
  it.each([
    'http://127.0.0.1:8080',
    'https://proxy.example.com:8443',
    'socks://127.0.0.1:1080',
    'socks5://127.0.0.1:1080',
  ])('accepts proxy protocols supported by the runtime dispatcher: %s', (url) => {
    expect(isValidProxyUrl(url)).toBe(true);
  });

  it('rejects SOCKS4 because the runtime ProxyAgent does not support it', () => {
    expect(isValidProxyUrl('socks4://127.0.0.1:1080')).toBe(false);
  });

  it.each(['ftp://proxy.example.com', 'not-a-url', ''])('rejects invalid proxy URL: %s', (url) => {
    expect(isValidProxyUrl(url)).toBe(false);
  });
});
