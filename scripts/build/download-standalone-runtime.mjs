import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

const attempts = 3;
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
const transientNetworkCodes = new Set([
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

class HttpStatusError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

// Each attempt owns the complete body deadline; only transient transport failures retry.
async function fetchWithRetry(url, timeoutMs, consume) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const signal = AbortSignal.timeout(timeoutMs);
    console.log(`Downloading ${url} (attempt ${attempt}/${attempts})`);
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new HttpStatusError(response.status);
      }
      assert(response.body, 'Node download has no body');
      return await consume(response);
    } catch (error) {
      const transient =
        (signal.reason?.name === 'TimeoutError' && error.name === 'AbortError') ||
        error.name === 'TimeoutError' ||
        (error instanceof HttpStatusError && transientStatuses.has(error.status)) ||
        transientNetworkCodes.has(error.cause?.code);
      if (!transient || attempt === attempts) {
        throw new Error(
          `Standalone download failed: ${url} (${attempt} attempts): ${error.message}`,
          { cause: error },
        );
      }
      console.warn(`Retrying standalone download after ${error.message}: ${url}`);
      await delay(attempt * 1000);
    }
  }
}

export async function fetchStandaloneText(url, { maxBytes, timeoutMs = 30_000 }) {
  return fetchWithRetry(url, timeoutMs, async (response) => {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of Readable.fromWeb(response.body)) {
      bytes += chunk.length;
      assert(bytes < maxBytes, 'Node download exceeds capacity');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  });
}

export async function downloadStandaloneAsset(url, destination, expectedHash, timeoutMs = 120_000) {
  await fetchWithRetry(url, timeoutMs, async (response) => {
    const digest = createHash('sha256');
    let bytes = 0;
    const verifier = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > 150 * 1024 * 1024) {
          callback(new Error('Node download exceeds capacity'));
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(destination));
      assert.equal(digest.digest('hex'), expectedHash, 'Official Node checksum mismatch');
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
  });
}
