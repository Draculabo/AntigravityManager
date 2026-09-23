import { HttpStatus } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isFunction, isString } from 'lodash-es';
import type { Observable } from 'rxjs';

import {
  captureHijackedHttpResponseChunk,
  completeHijackedHttpResponse,
  getProxyResponseTimingContext,
} from '@/modules/proxy-gateway/audit/traffic-audit-context';
import {
  buildProxyResponseTimingHeaders,
  markProxyUpstreamFirstByte,
  setProxyResponseTimingHeaders,
} from './proxy-response-timing';

interface SseResponseOptions {
  includeTiming?: boolean;
  request?: FastifyRequest;
}

interface HeaderState {
  written: boolean;
}

function writeHeadersOnce(
  reply: FastifyReply,
  request: FastifyRequest | undefined,
  includeTiming: boolean,
  state: HeaderState,
): void {
  if (state.written) {
    return;
  }
  state.written = true;
  reply.raw.writeHead(HttpStatus.OK, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...(includeTiming ? buildProxyResponseTimingHeaders(request) : {}),
  });
}

function writeChunk(reply: FastifyReply, request: FastifyRequest | undefined, chunk: string): void {
  captureHijackedHttpResponseChunk(request, chunk);
  reply.raw.write(chunk);
}

/** Timed streams send headers only after their first upstream chunk fixes TTFT. */
export function writeProxySseResponse(
  reply: FastifyReply,
  stream: Observable<unknown>,
  options: SseResponseOptions = {},
): void {
  const request = options.request ?? reply.request;
  const includeTiming = options.includeTiming === true;
  if (!reply.raw || !isFunction(reply.raw.writeHead) || !isFunction(reply.raw.write)) {
    if (includeTiming) {
      setProxyResponseTimingHeaders(reply, request);
    }
    reply.header('Content-Type', 'text/event-stream');
    reply.header('Cache-Control', 'no-cache');
    reply.header('Connection', 'keep-alive');
    reply.send(stream);
    return;
  }

  if (isFunction((reply as { hijack?: () => void }).hijack)) {
    (reply as { hijack: () => void }).hijack();
  }

  const headerState: HeaderState = { written: false };
  if (!includeTiming) {
    writeHeadersOnce(reply, request, false, headerState);
  }

  const subscription = stream.subscribe({
    next: (chunk) => {
      if (reply.raw.writableEnded) {
        return;
      }
      if (includeTiming) {
        markProxyUpstreamFirstByte(getProxyResponseTimingContext(request)?.proxyTiming);
        writeHeadersOnce(reply, request, true, headerState);
      }
      writeChunk(reply, request, isString(chunk) ? chunk : String(chunk ?? ''));
    },
    error: (error) => {
      if (reply.raw.writableEnded) {
        return;
      }
      writeHeadersOnce(reply, request, includeTiming, headerState);
      const message = error instanceof Error ? error.message : String(error);
      writeChunk(
        reply,
        request,
        `data: ${JSON.stringify({ error: { message, type: 'server_error' } })}\n\n`,
      );
      completeHijackedHttpResponse(request, reply, { error, partial: true });
      reply.raw.end();
    },
    complete: () => {
      if (!reply.raw.writableEnded) {
        writeHeadersOnce(reply, request, includeTiming, headerState);
        completeHijackedHttpResponse(request, reply);
        reply.raw.end();
      }
    },
  });

  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) {
      completeHijackedHttpResponse(request, reply, { partial: true });
    }
    subscription.unsubscribe();
  });
}
