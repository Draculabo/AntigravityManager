import axios, { isAxiosError } from 'axios';
import { CORE_OWNER_EPOCH_HEADER } from '@/core/management/handshake';
import { getRemoteIpcCapture } from '@/modules/proxy-gateway/audit/ipc-capture-transport-context';
import {
  IPC_CAPTURE_CHUNK_REQUEST_BYTES,
  IPC_CAPTURE_HEADER,
} from '@/modules/proxy-gateway/audit/ipc-capture.schema';
import { ServiceNotRunningError } from '@/core/management/client';
import { SERVICE_CONFIG_MAX_BYTES } from '@/modules/config/service-config.schema';
import { OPEN_CODE_SYNC_MAX_BYTES } from '@/modules/proxy-gateway/opencode-sync/opencode-owner.schema';

const MAX_REQUEST_BYTES = 4096;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;

export class CoreRpcTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreRpcTransportError';
  }
}

function classifyError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) {
    return new CoreRpcTransportError('Core RPC request was cancelled');
  }
  let code: unknown;
  if (isAxiosError(error)) {
    code = error.code;
  } else if (error instanceof Error && 'code' in error) {
    code = error.code;
  }
  if (code === 'ENOENT' || code === 'ECONNREFUSED') {
    return new ServiceNotRunningError();
  }
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
    return new CoreRpcTransportError('Core RPC request timed out');
  }
  if (
    code === 'ERR_BAD_RESPONSE' &&
    isAxiosError(error) &&
    error.message.includes('maxContentLength')
  ) {
    return new CoreRpcTransportError('Core RPC response is too large');
  }
  return error instanceof Error ? error : new CoreRpcTransportError('Core RPC request failed');
}

async function readBoundedRequestBody(request: Request): Promise<Buffer> {
  const pathname = new URL(request.url).pathname;
  let maxBytes = MAX_REQUEST_BYTES;
  switch (pathname) {
    case '/rpc/ipcCapture/append':
    case '/rpc/ipcCapture/appendMetadata':
      maxBytes = IPC_CAPTURE_CHUNK_REQUEST_BYTES;
      break;
    case '/rpc/serviceConfig/update':
      maxBytes = SERVICE_CONFIG_MAX_BYTES + 4096;
      break;
    case '/rpc/openCode/sync':
      maxBytes = OPEN_CODE_SYNC_MAX_BYTES + 4096;
      break;
  }
  if (!request.body) {
    return Buffer.alloc(0);
  }
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new CoreRpcTransportError('Core RPC request is too large');
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

/** Fetch-compatible transport over the same private pipe/socket as management IPC. */
export function createLocalRpcFetch(
  endpoint: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ownerEpoch?: string,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const body = await readBoundedRequestBody(request);
    if (request.signal.aborted) {
      throw new CoreRpcTransportError('Core RPC request was cancelled');
    }

    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    if (ownerEpoch) {
      headers[CORE_OWNER_EPOCH_HEADER] = ownerEpoch;
    }
    const capture = getRemoteIpcCapture(endpoint);
    if (capture && !url.pathname.startsWith('/rpc/ipcCapture/')) {
      headers[IPC_CAPTURE_HEADER] = `${capture.epoch}.${capture.token}`;
    }

    let incoming;
    try {
      incoming = await axios.request<Buffer>({
        url: `http://localhost${url.pathname}${url.search}`,
        adapter: 'http',
        socketPath: endpoint,
        httpAgent: false,
        method: request.method,
        headers,
        data: body.length > 0 ? body : undefined,
        signal: request.signal,
        timeout: timeoutMs,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxRedirects: 0,
        proxy: false,
        responseType: 'arraybuffer',
        validateStatus: () => true,
      });
    } catch (error) {
      throw classifyError(error, request.signal);
    }

    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) {
        responseHeaders.set(key, value.join(', '));
      } else if (typeof value === 'string' || typeof value === 'number') {
        responseHeaders.set(key, String(value));
      }
    }
    const bytes = incoming.data ? Buffer.from(incoming.data) : Buffer.alloc(0);
    return new Response(bytes.length > 0 ? bytes : null, {
      status: incoming.status,
      headers: responseHeaders,
    });
  };
}
