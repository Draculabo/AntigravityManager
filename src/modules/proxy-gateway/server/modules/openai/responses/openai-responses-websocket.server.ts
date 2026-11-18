import { getGenerationTimeoutMs } from '../../../common/generation-timeout-policy';
import type { IncomingMessage, Server } from 'node:http';
import { SchemaInputError } from '@/modules/proxy-gateway/antigravity/schema/SchemaConversion';
import type { Duplex } from 'node:stream';

import { isObservable, Subscriber, type Observable } from 'rxjs';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { FlowControlledSseStream } from '../../../common/flow-controlled-sse-stream';
import { awaitRequestOperation, throwIfRequestAborted } from '../../../common/request-cancellation';
import { GenerationDeadlineScope } from '../../../common/generation-deadline';
import { DEFAULT_PROXY_JSON_BODY_LIMIT_BYTES } from '../../../proxy.constants';
import { logger } from '@/shared/logging/logger';
import { ResponsesWebSocketOutput } from './responses-websocket-output';
import { IncrementalSseLines } from '../../../common/incremental-sse-lines';
import { takeSerializedResponsesFrame } from './serialized-responses-frames';
import type { SignatureScopeContext } from '../../../common/signature-session-scope';

import {
  OpenAIResponsesWebSocketProtocol,
  type OpenAIResponsesWebSocketEvent,
} from './openai-responses-websocket.protocol';

import { publicProxyErrorMessage } from '../../../common/public-error-message';
import { openAIHttpErrorFields } from '../../../common/public-http-error-fields';
import { resolveUpstreamErrorHttpStatus } from '../../../common/upstream-error-http-status';
import { HttpException } from '@nestjs/common';
import { ResponsesThoughtContext } from './responses-thought-context';

export interface OpenAIResponsesWebSocketServerDependencies {
  createAudit?: (
    payload: unknown,
    context: SignatureScopeContext,
  ) => {
    record(sse: string): void;
    finish(error?: unknown, cancelled?: boolean): Promise<void>;
  };
  validateRequest?: (
    request: Record<string, unknown>,
    mode: 'prewarm' | 'generate',
    context?: SignatureScopeContext,
  ) => void | Promise<void>;
  isAuthorized: (request: IncomingMessage) => boolean;
  streamRequest: (
    request: Record<string, unknown>,
    signal?: AbortSignal,
    context?: SignatureScopeContext,
  ) => Promise<Observable<unknown>>;
}

/**
 * Attaches the Codex Responses WebSocket transport to an existing HTTP server.
 * Non-Responses upgrades are left untouched for other upgrade listeners.
 */
export function attachOpenAIResponsesWebSocketServer(
  server: Server,
  dependencies: OpenAIResponsesWebSocketServerDependencies,
): () => void {
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: DEFAULT_PROXY_JSON_BODY_LIMIT_BYTES,
  });
  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const pathname = resolvePathname(request.url);
    if (pathname !== '/v1/responses') {
      return;
    }
    if (!dependencies.isAuthorized(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  };

  webSocketServer.on('connection', (socket, request) => {
    handleConnection(socket, dependencies, { headers: request.headers, url: request.url });
  });
  server.on('upgrade', handleUpgrade);

  return () => {
    server.off('upgrade', handleUpgrade);
    for (const client of webSocketServer.clients) {
      client.terminate();
    }
    webSocketServer.close();
  };
}

function handleConnection(
  socket: WebSocket,
  dependencies: OpenAIResponsesWebSocketServerDependencies,
  context: SignatureScopeContext,
): void {
  const validate = dependencies.validateRequest;
  const protocol = new OpenAIResponsesWebSocketProtocol(
    validate ? (request, mode) => validate(request, mode, context) : undefined,
  );
  const thoughtContext = new ResponsesThoughtContext(protocol);
  let activeSubscription: Subscriber<unknown> | null = null;
  let output: ResponsesWebSocketOutput | null = null;
  const abort = new AbortController();
  let queuedBytes = 0;
  let queuedRequests = 0;
  let processing = Promise.resolve();
  const failTransport = (error: Error): void => {
    logger.warn(error.message);
    abort.abort();
    thoughtContext.dispose();
    activeSubscription?.unsubscribe();
    output?.stop();
    socket.terminate();
  };

  socket.on('message', (rawData) => {
    if (abort.signal.aborted) {
      return;
    }
    const bytes = rawDataBytes(rawData);
    if (queuedRequests >= 16 || queuedBytes + bytes > 128 * 1024 * 1024) {
      failTransport(new Error('Responses WebSocket request queue budget exceeded'));
      return;
    }
    queuedBytes += bytes;
    queuedRequests++;
    processing = processing
      .then(async () => {
        if (abort.signal.aborted) {
          return;
        }
        const payload = parseClientPayload(rawData);
        return thoughtContext.run(payload, context, async () => {
          const audit = dependencies.createAudit?.(payload, context);
          let frameError: unknown;
          const deadline = new GenerationDeadlineScope(getGenerationTimeoutMs(), abort.signal);
          const signal = deadline.signal;
          try {
            const action = await protocol.accept(payload, signal);
            if (!thoughtContext.mayRetain()) {
              throw new Error('Responses history was invalidated');
            }
            if (action.kind === 'local') {
              for (const event of action.events) {
                audit?.record(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
              }
              await sendEvents(socket, action.events, failTransport);
              return;
            }

            const pendingStream = dependencies.streamRequest(action.request, signal, context);
            void pendingStream.then(
              (lateStream) => {
                if (signal.aborted && lateStream instanceof FlowControlledSseStream) {
                  lateStream.destroy();
                }
              },
              () => {},
            );
            const stream = await awaitRequestOperation(pendingStream, signal);
            throwIfRequestAborted(signal);
            if (!isObservable(stream)) {
              throw new Error('Responses WebSocket upstream did not return a stream');
            }
            const parseUpstreamChunk = createUpstreamEventParser();
            output = new ResponsesWebSocketOutput(
              socket,
              stream instanceof FlowControlledSseStream ? stream : null,
              failTransport,
            );
            const currentOutput = output;
            let cancel: (() => void) | undefined;
            try {
              await new Promise<void>((resolve, reject) => {
                cancel = (): void => reject(signal.reason);
                signal.addEventListener('abort', cancel, { once: true });
                const subscriber = new Subscriber<unknown>({
                  next: (chunk) => {
                    try {
                      const canonical = takeSerializedResponsesFrame(stream, chunk);
                      if (canonical) {
                        audit?.record(canonical.sse);
                        currentOutput.enqueueSerialized(canonical.json);
                        if (
                          !signal.aborted &&
                          thoughtContext.mayRetain() &&
                          canonical.completedState
                        ) {
                          protocol.complete(canonical.completedState);
                        }
                        return;
                      }
                      for (const event of parseUpstreamChunk(chunk)) {
                        audit?.record(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                        currentOutput.enqueue(event);
                        if (signal.aborted) {
                          break;
                        }
                        if (event.type === 'response.completed' && thoughtContext.mayRetain()) {
                          protocol.complete(event.response);
                        }
                      }
                    } catch {
                      failTransport(
                        new Error('Responses WebSocket upstream event exceeds decode budget'),
                      );
                    }
                  },
                  error: reject,
                  complete: () => currentOutput.end(resolve),
                });
                activeSubscription = subscriber;
                stream.subscribe(subscriber);
              });
            } finally {
              if (cancel) {
                signal.removeEventListener('abort', cancel);
              }
              activeSubscription?.unsubscribe();
              activeSubscription = null;
              currentOutput.stop();
              output = null;
            }
          } catch (error) {
            frameError = error;
            if (audit && !abort.signal.aborted) {
              const event = createWebSocketErrorEvent(error);
              audit.record(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            }
            throw error;
          } finally {
            deadline.dispose();
            await audit?.finish(frameError, abort.signal.aborted);
          }
        });
      })
      .catch(async (error: unknown) => {
        if (abort.signal.aborted) {
          return;
        }
        await sendEvents(socket, [createWebSocketErrorEvent(error)], failTransport);
      })
      .finally(() => {
        queuedBytes -= bytes;
        queuedRequests--;
      });
  });

  socket.once('close', () => {
    abort.abort();
    thoughtContext.dispose();
    output?.stop();
    activeSubscription?.unsubscribe();
    activeSubscription = null;
  });
  socket.once('error', () => failTransport(new Error('Responses WebSocket socket failed')));
}

function createWebSocketErrorEvent(error: unknown): OpenAIResponsesWebSocketEvent {
  return {
    type: 'error',
    error: {
      message: publicProxyErrorMessage(error instanceof Error ? error.message : String(error)),
      ...openAIHttpErrorFields(
        error instanceof HttpException
          ? error.getStatus()
          : error instanceof SchemaInputError
            ? 400
            : (resolveUpstreamErrorHttpStatus(error) ?? 500),
        error,
      ),
      ...(error instanceof SchemaInputError ? { code: 'invalid_schema' } : {}),
    },
  };
}

function parseClientPayload(rawData: RawData): unknown {
  try {
    const payload: unknown = JSON.parse(rawDataToString(rawData));
    return payload;
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createUpstreamEventParser(): (chunk: unknown) => Iterable<OpenAIResponsesWebSocketEvent> {
  const lines = new IncrementalSseLines();
  let dataLines: string[] = [];
  let retainedBytes = 0;
  return function* (chunk: unknown): Generator<OpenAIResponsesWebSocketEvent> {
    if (typeof chunk !== 'string') {
      if (isResponsesEvent(chunk)) {
        yield chunk;
      }
      return;
    }

    for (const rawLine of lines.push(chunk)) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line === '') {
        const data = dataLines.join('\n');
        dataLines = [];
        retainedBytes = 0;
        const event = parseUpstreamEventData(data);
        if (event) {
          yield event;
        }
      } else if (line.startsWith('data:')) {
        retainedBytes += line.length * 2 + 64;
        if (retainedBytes > 128 * 1024 * 1024) {
          throw new Error('Responses event decode budget exceeded');
        }
        dataLines.push(line.slice(5).trimStart());
      }
    }
  };
}

function parseUpstreamEventData(data: string): OpenAIResponsesWebSocketEvent | null {
  if (!data || data === '[DONE]') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(data);
    if (isResponsesEvent(parsed)) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function sendEvents(
  socket: WebSocket,
  events: OpenAIResponsesWebSocketEvent[],
  fail: (error: Error) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const output = new ResponsesWebSocketOutput(socket, null, (error) => {
      fail(error);
      resolve();
    });
    const close = (): void => {
      output.stop();
      resolve();
    };
    socket.once('close', close);
    for (const event of events) {
      output.enqueue(event);
    }
    output.end(() => {
      socket.off('close', close);
      resolve();
    });
  });
}

function rawDataBytes(rawData: RawData): number {
  if (Array.isArray(rawData)) {
    return rawData.reduce((bytes, part) => bytes + part.length, 0);
  }
  return rawData instanceof ArrayBuffer ? rawData.byteLength : rawData.length;
}

function rawDataToString(rawData: RawData): string {
  if (Array.isArray(rawData)) {
    return Buffer.concat(rawData).toString('utf8');
  }
  if (rawData instanceof ArrayBuffer) {
    return Buffer.from(rawData).toString('utf8');
  }
  return rawData.toString('utf8');
}

function resolvePathname(url: string | undefined): string {
  try {
    return new URL(url ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

function isResponsesEvent(value: unknown): value is OpenAIResponsesWebSocketEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof Reflect.get(value, 'type') === 'string'
  );
}
