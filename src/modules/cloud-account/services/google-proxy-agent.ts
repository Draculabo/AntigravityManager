import type { AxiosProxyConfig } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';
import {
  UpstreamProxyConfigurationError,
  UpstreamProxyUrlSchema,
} from '@/modules/config/upstream-proxy.schema';

/** Explicit proxy settings take precedence; environment routing retains NO_PROXY semantics. */
export function createGoogleProxyAgent(
  url: string,
  proxy?: AxiosProxyConfig | false,
  signal?: AbortSignal,
): HttpsProxyAgent<string> | undefined {
  if (proxy === false) {
    return undefined;
  }
  let proxyUrl: string;
  if (proxy) {
    const host = proxy.host.includes(':') ? '[' + proxy.host + ']' : proxy.host;
    const parsed = new URL((proxy.protocol ?? 'http') + '://' + host);
    parsed.port = String(proxy.port);
    if (proxy.auth) {
      parsed.username = proxy.auth.username;
      parsed.password = proxy.auth.password;
    }
    proxyUrl = parsed.href;
  } else {
    proxyUrl = getProxyForUrl(url);
  }
  if (!proxyUrl) {
    return undefined;
  }
  const parsed = UpstreamProxyUrlSchema.safeParse(proxyUrl);
  if (!parsed.success) {
    throw new UpstreamProxyConfigurationError();
  }
  return new HttpsProxyAgent(parsed.data, { signal });
}
