import { HttpStatus } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isFunction, isString } from 'lodash-es';
import { Subscriber, type Observable } from 'rxjs';
import { logger } from '@/shared/logging/logger';
import { FlowControlledSseStream } from './flow-controlled-sse-stream';
import { SseOutputPump } from './sse-output-pump';

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
import { getObservableFlowControl } from './observable-flow-control';
import { publicProxyErrorMessage } from './public-error-message';
import { publicProxyRequestId } from './public-request-id';

interface SseResponseOptions {
  includeTiming?: boolean;
  request?: FastifyRequest;
  formatUnstartedError?: (error: unknown) => { status: HttpStatus; body: object } | undefined;
}

// Observable producers cannot be paused by this transport. Bound pending output and fail explicitly.
const MAX_PENDING_SSE_BYTES = 16 * 1024 * 1024;

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
    ...(publicProxyRequestId(request) ? { 'X-Request-Id': publicProxyRequestId(request) } : {}),
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
  let terminal = false;
  let sourceError: unknown;
  let hasSourceError = false;
  if (!includeTiming) {
    writeHeadersOnce(reply, request, false, headerState);
  }

  const flow =
    stream instanceof FlowControlledSseStream ? stream : getObservableFlowControl(stream);
  const pump = flow
    ? new SseOutputPump({
        write: (text) => {
          if (includeTiming) {
            markProxyUpstreamFirstByte(getProxyResponseTimingContext(request)?.proxyTiming);
          }
          writeHeadersOnce(reply, request, includeTiming, headerState);
          captureHijackedHttpResponseChunk(request, text);
          // Copy small slices so Node's socket does not retain the whole parent event string.
          return reply.raw.write(Buffer.from(text, 'utf8'));
        },
        pause: () => flow.pause(),
        resume: () => {
          if (!terminal) {
            flow.resume();
          }
        },
        finish: () => {
          if (terminal) {
            return;
          }
          terminal = true;
          writeHeadersOnce(reply, request, includeTiming, headerState);
          completeHijackedHttpResponse(
            request,
            reply,
            hasSourceError ? { error: sourceError, partial: true } : {},
          );
          reply.raw.end();
        },
        fail: (error) => {
          if (terminal) {
            return;
          }
          terminal = true;
          logger.warn(error.message);
          completeHijackedHttpResponse(request, reply, { error, partial: true });
          subscriber.unsubscribe();
          reply.raw.destroy();
        },
      })
    : null;
  const subscriber = new Subscriber<unknown>({
    next: (chunk) => {
      if (terminal || reply.raw.writableEnded || reply.raw.destroyed) {
        return;
      }
      const text = isString(chunk) ? chunk : String(chunk ?? '');
      if (pump) {
        pump.enqueue(text);
        return;
      }
      const incomingBytes = Buffer.byteLength(text, 'utf8');
      if (reply.raw.writableLength + incomingBytes > MAX_PENDING_SSE_BYTES) {
        terminal = true;
        const error = new Error('SSE response backpressure limit exceeded');
        logger.warn(error.message, {
          pendingBytes: reply.raw.writableLength,
          incomingBytes,
          limitBytes: MAX_PENDING_SSE_BYTES,
        });
        completeHijackedHttpResponse(request, reply, { error, partial: true });
        subscriber.unsubscribe();
        // A full socket cannot reliably deliver another error frame; close without a success marker.
        reply.raw.destroy();
        return;
      }
      if (includeTiming) {
        markProxyUpstreamFirstByte(getProxyResponseTimingContext(request)?.proxyTiming);
        writeHeadersOnce(reply, request, true, headerState);
      }
      writeChunk(reply, request, text);
    },
    error: (error: unknown) => {
      if (terminal || reply.raw.writableEnded || reply.raw.destroyed) {
        return;
      }
      const response =
        !headerState.written && !reply.raw.headersSent
          ? options.formatUnstartedError?.(error)
          : undefined;
      if (response) {
        terminal = true;
        pump?.stop();
        const requestId = publicProxyRequestId(request);
        reply.raw.writeHead(response.status, {
          ...(requestId ? { 'X-Request-Id': requestId } : {}),
          'Content-Type': 'application/json; charset=utf-8',
        });
        completeHijackedHttpResponse(request, reply, { error, body: response.body });
        reply.raw.end(JSON.stringify(response.body));
        return;
      }
      writeHeadersOnce(reply, request, includeTiming, headerState);
      const message = publicProxyErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
      const errorFrame = `data: ${JSON.stringify({ error: { message, type: 'server_error' } })}\n\n`;
      if (pump) {
        hasSourceError = true;
        sourceError = error;
        pump.enqueue(errorFrame);
        pump.end();
        return;
      }
      terminal = true;
      if (
        reply.raw.writableLength + Buffer.byteLength(errorFrame, 'utf8') >
        MAX_PENDING_SSE_BYTES
      ) {
        logger.warn('SSE error response backpressure limit exceeded', {
          pendingBytes: reply.raw.writableLength,
          incomingBytes: Buffer.byteLength(errorFrame, 'utf8'),
          limitBytes: MAX_PENDING_SSE_BYTES,
        });
        completeHijackedHttpResponse(request, reply, { error, partial: true });
        reply.raw.destroy();
        return;
      }
      writeChunk(reply, request, errorFrame);
      completeHijackedHttpResponse(request, reply, { error, partial: true });
      reply.raw.end();
    },
    complete: () => {
      if (pump) {
        pump.end();
        return;
      }
      if (!terminal && !reply.raw.writableEnded && !reply.raw.destroyed) {
        terminal = true;
        writeHeadersOnce(reply, request, includeTiming, headerState);
        completeHijackedHttpResponse(request, reply);
        reply.raw.end();
      }
    },
  });

  const onDrain = () => pump?.drain();
  if (pump) {
    reply.raw.on('drain', onDrain);
  }
  reply.raw.on('close', () => {
    pump?.stop();
    if (pump) {
      reply.raw.removeListener('drain', onDrain);
    }
    if (!terminal && !reply.raw.writableFinished) {
      terminal = true;
      completeHijackedHttpResponse(request, reply, { partial: true });
    }
    subscriber.unsubscribe();
  });
  // Install close handling and own the Subscriber before a synchronous source can emit.
  stream.subscribe(subscriber);
}
