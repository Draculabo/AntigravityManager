import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Observable } from 'rxjs';

const CAPTURED_HEADER_NAMES = new Set([
  'anthropic-beta',
  'anthropic-version',
  'content-type',
  'user-agent',
  'x-goog-api-client',
]);

export interface UpstreamCaptureContext {
  clientRequest: {
    body: unknown;
    endpoint: string;
    headers: Record<string, unknown>;
  };
}

const upstreamCaptureContext = new AsyncLocalStorage<UpstreamCaptureContext>();

export function getUpstreamCaptureContext(): UpstreamCaptureContext | undefined {
  return upstreamCaptureContext.getStore();
}

export function runWithUpstreamCaptureContext<T>(
  context: UpstreamCaptureContext,
  callback: () => T,
): T {
  return upstreamCaptureContext.run(context, callback);
}

export function isUpstream4xxCaptureEnabled(): boolean {
  return process.env.AGM_UPSTREAM_4XX_CAPTURE === '1';
}

/** Preserves the incoming wire request until the shared upstream transport (GeminiClient) resolves it. */
@Injectable()
export class UpstreamCaptureContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!isUpstream4xxCaptureEnabled()) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<{
      body?: unknown;
      headers?: Record<string, unknown>;
      url?: string;
    }>();

    const captureContext: UpstreamCaptureContext = {
      clientRequest: {
        body: snapshotRequestBody(request.body),
        endpoint: request.url ?? '',
        headers: selectCaptureHeaders(request.headers),
      },
    };

    return new Observable((subscriber) =>
      upstreamCaptureContext.run(captureContext, () => next.handle().subscribe(subscriber)),
    );
  }
}

function selectCaptureHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!headers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => CAPTURED_HEADER_NAMES.has(name.toLowerCase())),
  );
}

function snapshotRequestBody(body: unknown): unknown {
  if (body === undefined) {
    return undefined;
  }

  try {
    return structuredClone(body);
  } catch {
    return body;
  }
}
