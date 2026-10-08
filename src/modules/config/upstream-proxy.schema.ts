import { z } from 'zod';
import type { AppConfig } from './types';

/** Matches the HTTP(S) proxy protocols and credential encoding used by the Google client. */
export const UpstreamProxyUrlSchema = z
  .string()
  .trim()
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return false;
      }
      decodeURIComponent(url.username);
      decodeURIComponent(url.password);
      return true;
    } catch {
      return false;
    }
  });

export const UPSTREAM_PROXY_CONFIGURATION_MESSAGE =
  'Configure a valid HTTP(S) upstream proxy URL or disable the upstream proxy in Settings.';

export class UpstreamProxyConfigurationError extends Error {
  constructor() {
    super(UPSTREAM_PROXY_CONFIGURATION_MESSAGE);
    this.name = 'UpstreamProxyConfigurationError';
  }
}

/** Reject an enabled invalid proxy without changing the user's routing choice. */
export function assertValidUpstreamProxyConfig(proxy: AppConfig['proxy']['upstream_proxy']): void {
  if (proxy.enabled && !UpstreamProxyUrlSchema.safeParse(proxy.url).success) {
    throw new UpstreamProxyConfigurationError();
  }
}
