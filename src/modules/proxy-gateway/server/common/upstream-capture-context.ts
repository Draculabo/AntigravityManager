import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Observable } from 'rxjs';

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

/** Preserves the incoming wire request until the shared upstream transport (GeminiClient) resolves it. */
@Injectable()
export class UpstreamCaptureContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (process.env.AGM_UPSTREAM_4XX_CAPTURE !== '1') {
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
        headers: { ...(request.headers ?? {}) },
      },
    };

    return new Observable((subscriber) =>
      upstreamCaptureContext.run(captureContext, () => next.handle().subscribe(subscriber)),
    );
  }
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
