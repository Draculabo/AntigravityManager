import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { isObservable, type Observable, type Subscription } from 'rxjs';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import {
  OpenAIResponsesWebSocketProtocol,
  type OpenAIResponsesWebSocketEvent,
} from './openai-responses-websocket.protocol';

export interface OpenAIResponsesWebSocketServerDependencies {
  isAuthorized: (request: IncomingMessage) => boolean;
  streamRequest: (request: Record<string, unknown>) => Promise<Observable<unknown>>;
}

/**
 * Attaches the Codex Responses WebSocket transport to an existing HTTP server.
 * Non-Responses upgrades are left untouched for other upgrade listeners.
 */
export function attachOpenAIResponsesWebSocketServer(
  server: Server,
  dependencies: OpenAIResponsesWebSocketServerDependencies,
): () => void {
  const webSocketServer = new WebSocketServer({ noServer: true });
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

  webSocketServer.on('connection', (socket) => {
    handleConnection(socket, dependencies);
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
): void {
  const protocol = new OpenAIResponsesWebSocketProtocol();
  let activeSubscription: Subscription | null = null;
  let closed = false;
  let processing = Promise.resolve();

  socket.on('message', (rawData) => {
    processing = processing
      .then(async () => {
        const payload = parseClientPayload(rawData);
        const action = protocol.accept(payload);
        if (action.kind === 'local') {
          for (const event of action.events) {
            sendEvent(socket, event);
          }
          return;
        }

        const stream = await dependencies.streamRequest(action.request);
        if (closed) {
          return;
        }
        if (!isObservable(stream)) {
          throw new Error('Responses WebSocket upstream did not return a stream');
        }
        const parseUpstreamChunk = createUpstreamEventParser();
        try {
          await new Promise<void>((resolve, reject) => {
            activeSubscription = stream.subscribe({
              next: (chunk) => {
                for (const event of parseUpstreamChunk(chunk)) {
                  sendEvent(socket, event);
                  if (event.type === 'response.completed') {
                    protocol.complete(event.response);
                  }
                }
              },
              error: reject,
              complete: resolve,
            });
          });
        } finally {
          activeSubscription = null;
        }
      })
      .catch((error: unknown) => {
        sendEvent(socket, {
          type: 'error',
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: 'server_error',
          },
        });
      });
  });

  socket.once('close', () => {
    closed = true;
    activeSubscription?.unsubscribe();
    activeSubscription = null;
  });
}

function parseClientPayload(rawData: RawData): unknown {
  try {
    return JSON.parse(rawDataToString(rawData)) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createUpstreamEventParser(): (chunk: unknown) => OpenAIResponsesWebSocketEvent[] {
  let buffer = '';
  return (chunk: unknown): OpenAIResponsesWebSocketEvent[] => {
    if (typeof chunk !== 'string') {
      return isResponsesEvent(chunk) ? [chunk] : [];
    }

    buffer += chunk;
    const events: OpenAIResponsesWebSocketEvent[] = [];
    while (true) {
      const separator = /\r?\n\r?\n/.exec(buffer);
      if (!separator || separator.index === undefined) {
        break;
      }
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const event = parseUpstreamEventBlock(block);
      if (event) {
        events.push(event);
      }
    }
    return events;
  };
}

function parseUpstreamEventBlock(block: string): OpenAIResponsesWebSocketEvent | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n');
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

function sendEvent(socket: WebSocket, event: OpenAIResponsesWebSocketEvent): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
  }
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
