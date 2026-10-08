import axios, { isAxiosError } from 'axios';
import type { ZodType } from 'zod';
import type { CoreStatus } from '@/core/core-service';
import { CORE_OWNER_EPOCH_HEADER, CoreHandshakeSchema, type CoreHandshake } from './handshake';
import {
  ManagementShutdownResponseSchema,
  ManagementStatusResponseSchema,
  OAuthCancelResponseSchema,
  OAuthCompleteResponseSchema,
  OAuthErrorResponseSchema,
  OAuthStartResponseSchema,
  OAuthStatusResponseSchema,
  type OAuthStartRequest,
  type OAuthCompleteRequest,
  type OAuthErrorResponse,
} from './protocol';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 4096;

export class ServiceNotRunningError extends Error {
  constructor() {
    super('Core service is not running');
    this.name = 'ServiceNotRunningError';
  }
}

export class ManagementProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagementProtocolError';
  }
}

export class ManagementTimeoutError extends Error {
  constructor() {
    super('Core management request timed out');
    this.name = 'ManagementTimeoutError';
  }
}

export class OAuthManagementError extends Error {
  constructor(
    readonly code: OAuthErrorResponse['code'],
    message: string,
  ) {
    super(message);
    this.name = 'OAuthManagementError';
  }
}

function classifyConnectionError(error: unknown): Error {
  if (error instanceof ManagementTimeoutError) {
    return error;
  }
  if (isAxiosError(error)) {
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return new ManagementTimeoutError();
    }
    if (error.code === 'ERR_BAD_RESPONSE' && error.message.includes('maxContentLength')) {
      return new ManagementProtocolError('Management response is too large');
    }
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ECONNREFUSED') {
    return new ServiceNotRunningError();
  }
  return error instanceof Error ? error : new Error('Core management connection failed');
}

export class ManagementClient {
  constructor(
    private readonly endpoint: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly ownerEpoch?: string,
  ) {}

  private async request<T>(
    method: 'GET' | 'POST',
    route: string,
    schema: ZodType<T>,
    body?: OAuthStartRequest | OAuthCompleteRequest,
  ): Promise<T> {
    let response;
    try {
      response = await axios.request<Buffer>({
        url: `http://localhost${route}`,
        adapter: 'http',
        socketPath: this.endpoint,
        httpAgent: false,
        method,
        data: body,
        timeout: this.timeoutMs,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxRedirects: 0,
        proxy: false,
        responseType: 'arraybuffer',
        validateStatus: () => true,
        headers: {
          'Content-Type': body ? 'application/json' : null,
          ...(this.ownerEpoch ? { [CORE_OWNER_EPOCH_HEADER]: this.ownerEpoch } : {}),
        },
      });
    } catch (error) {
      throw classifyConnectionError(error);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(response.data).toString('utf8'));
    } catch {
      throw new ManagementProtocolError('Management response is not valid JSON');
    }
    if (response.status !== 200) {
      const oauthError = OAuthErrorResponseSchema.safeParse(payload);
      if (oauthError.success) {
        throw new OAuthManagementError(oauthError.data.code, oauthError.data.message);
      }
      throw new ManagementProtocolError(`Management request returned HTTP ${response.status}`);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ManagementProtocolError('Management response has an invalid version or shape');
    }
    return parsed.data;
  }

  async status(): Promise<CoreStatus> {
    const response = await this.request('GET', '/v1/status', ManagementStatusResponseSchema);
    return response.status;
  }

  handshake(): Promise<CoreHandshake> {
    return this.request('GET', '/v1/handshake', CoreHandshakeSchema);
  }

  async shutdown(): Promise<void> {
    await this.request('POST', '/v1/shutdown', ManagementShutdownResponseSchema);
  }

  async startOAuth(
    oauthClientKey?: string,
  ): Promise<{ sessionId: string; authorizationUrl: string }> {
    const response = await this.request('POST', '/v1/oauth/start', OAuthStartResponseSchema, {
      oauthClientKey,
    });
    return { sessionId: response.sessionId, authorizationUrl: response.authorizationUrl };
  }

  async oauthStatus(
    sessionId: string,
  ): Promise<(typeof OAuthStatusResponseSchema)['_output']['status']> {
    const response = await this.request(
      'GET',
      `/v1/oauth/status/${encodeURIComponent(sessionId)}`,
      OAuthStatusResponseSchema,
    );
    return response.status;
  }

  async cancelOAuth(sessionId: string): Promise<void> {
    await this.request(
      'POST',
      `/v1/oauth/cancel/${encodeURIComponent(sessionId)}`,
      OAuthCancelResponseSchema,
    );
  }

  async completeOAuth(sessionId: string, code: string): Promise<void> {
    await this.request(
      'POST',
      `/v1/oauth/complete/${encodeURIComponent(sessionId)}`,
      OAuthCompleteResponseSchema,
      { code },
    );
  }
}
