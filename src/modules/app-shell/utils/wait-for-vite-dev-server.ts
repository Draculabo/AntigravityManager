import axios from 'axios';
import { setTimeout as wait } from 'node:timers/promises';

export interface ViteServerWaitOptions {
  delayMs?: number;
  maxRetries?: number;
  request?: (url: string) => Promise<{ status: number }>;
}

async function requestViteDevServer(url: string): Promise<{ status: number }> {
  const response = await axios.get(url, {
    // Local development traffic must not use an environment-configured proxy.
    proxy: false,
    timeout: 1000,
    validateStatus: () => true,
  });
  return { status: response.status };
}

export async function waitForViteDevServer(
  url: string,
  { delayMs = 500, maxRetries = 30, request = requestViteDevServer }: ViteServerWaitOptions = {},
): Promise<number | null> {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const response = await request(url);
      if (response.status >= 200 && response.status < 300) {
        return attempt * delayMs;
      }
    } catch {
      // Server not ready yet.
    }

    await wait(delayMs);
  }

  return null;
}
