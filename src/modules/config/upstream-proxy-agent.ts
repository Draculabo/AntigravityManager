import type { AxiosProxyConfig } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';
import {
  UpstreamProxyConfigurationError,
  UpstreamProxyUrlSchema,
} from '@/modules/config/upstream-proxy.schema';

export interface ResolvedUpstreamProxy {
  endpoint: URL;
  headers?: Record<string, string>;
}

/** Explicit proxy settings take precedence; environment routing retains NO_PROXY semantics. */
export function resolveUpstreamProxy(
  url: string,
  proxy?: AxiosProxyConfig | false,
): ResolvedUpstreamProxy | undefined {
  if (proxy === false) {
    return undefined;
  }
  let proxyUrl: string;
  if (proxy) {
    const host =
      proxy.host.includes(':') && !proxy.host.startsWith('[') ? '[' + proxy.host + ']' : proxy.host;
    const parsed = new URL((proxy.protocol ?? 'http') + '://' + host);
    parsed.port = String(proxy.port);
    if (proxy.auth) {
      parsed.username = encodeURIComponent(proxy.auth.username);
      parsed.password = encodeURIComponent(proxy.auth.password);
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
  const endpoint = new URL(parsed.data);
  let headers: Record<string, string> | undefined;
  if (endpoint.username || endpoint.password) {
    const credential = `${decodeURIComponent(endpoint.username)}:${decodeURIComponent(endpoint.password)}`;
    headers = { 'Proxy-Authorization': `Basic ${Buffer.from(credential).toString('base64')}` };
    // The agent logs its constructor URL when transport debug logging is enabled.
    endpoint.username = '';
    endpoint.password = '';
  }
  return { endpoint, headers };
}

export function createUpstreamProxyAgent(
  url: string,
  proxy?: AxiosProxyConfig | false,
  signal?: AbortSignal,
): HttpsProxyAgent<string> | undefined {
  const resolved = resolveUpstreamProxy(url, proxy);
  return resolved
    ? new HttpsProxyAgent(resolved.endpoint, { headers: resolved.headers, signal })
    : undefined;
}
