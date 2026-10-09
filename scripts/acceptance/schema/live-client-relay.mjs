import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import path from 'node:path';
import { z } from 'zod';

/** Forward the real client's traffic unchanged; retain only controlled-probe evidence. */
export async function createLiveClientRelay({ gateway, trace, probe, marker, measureSchemas }) {
  const observations = [];
  const server = createServer((request, response) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      void (async () => {
        try {
          const bytes = Buffer.concat(chunks);
          const parsed = z
            .object({
              model: z.string().optional(),
              stream: z.boolean().optional(),
              messages: z.array(z.object({ content: z.unknown() })).optional(),
              tools: z.array(z.object({ name: z.string(), input_schema: z.unknown() })).optional(),
            })
            .parse(JSON.parse(bytes.toString('utf8')));
          const observation = {
            route: new URL(request.url, gateway).pathname === '/v1/messages' ? 'messages' : 'other',
            streaming: parsed.stream,
            readDeclared: parsed.tools?.some((tool) => tool.name === 'Read') === true,
            requestHasToolResult: false,
            requestHasMarker: false,
            responseReadCall: false,
            responseProbeMatched: false,
            responseMarkerMatched: false,
            responseTextBytes: 0,
            blockTypes: [],
            ...(measureSchemas ? { schemas: measureSchemas(parsed.tools ?? []) } : {}),
          };
          for (const message of parsed.messages ?? []) {
            if (!Array.isArray(message.content)) {
              continue;
            }
            for (const block of message.content) {
              const item = z
                .object({ type: z.string(), content: z.unknown().optional() })
                .safeParse(block);
              if (item.success && item.data.type === 'tool_result') {
                observation.requestHasToolResult = true;
                observation.requestHasMarker ||= JSON.stringify(item.data.content).includes(marker);
              }
            }
          }
          observations.push(observation);
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers)) {
            if (
              [
                'host',
                'content-length',
                'connection',
                'transfer-encoding',
                'accept-encoding',
              ].includes(name)
            ) {
              continue;
            }
            if (typeof value === 'string') {
              headers.set(name, value);
            }
          }
          headers.set('x-schema-acceptance', `${trace}:claude-code-live-read`);
          const upstream = await fetch(new URL(request.url, gateway), {
            method: request.method,
            headers,
            body: bytes,
            signal: AbortSignal.timeout(120_000),
          });
          observation.status = upstream.status;
          for (const [name, value] of upstream.headers) {
            if (
              !['content-length', 'transfer-encoding', 'connection', 'content-encoding'].includes(
                name,
              )
            ) {
              response.setHeader(name, value);
            }
          }
          response.writeHead(upstream.status);
          let captured = '';
          const stream = Readable.fromWeb(upstream.body);
          stream.on('data', (chunk) => {
            if (captured.length < 1_048_576) {
              captured += chunk.toString('utf8');
            }
          });
          stream.on('end', () => {
            let text = '';
            let inputJson = '';
            for (const line of captured.split('\n')) {
              if (!line.startsWith('data: ')) {
                continue;
              }
              let raw;
              try {
                raw = JSON.parse(line.slice(6));
              } catch {
                continue;
              }
              const event = z
                .object({
                  content_block: z
                    .object({
                      type: z.string(),
                      name: z.string().optional(),
                      input: z.unknown().optional(),
                    })
                    .optional(),
                  delta: z
                    .object({
                      type: z.string().optional(),
                      text: z.string().optional(),
                      partial_json: z.string().optional(),
                      stop_reason: z.string().optional(),
                    })
                    .optional(),
                })
                .safeParse(raw);
              if (!event.success) {
                continue;
              }
              if (event.data.content_block) {
                observation.blockTypes.push(event.data.content_block.type);
              }
              if (event.data.delta?.stop_reason) {
                observation.stopReason = event.data.delta.stop_reason;
              }
              if (
                event.data.content_block?.type === 'tool_use' &&
                event.data.content_block.name === 'Read'
              ) {
                observation.responseReadCall = true;
                const input = z
                  .object({ file_path: z.string() })
                  .safeParse(event.data.content_block.input);
                observation.responseProbeMatched ||=
                  input.success && path.resolve(input.data.file_path) === probe;
              }
              if (event.data.delta?.text) {
                text += event.data.delta.text;
              }
              if (event.data.delta?.partial_json) {
                inputJson += event.data.delta.partial_json;
              }
            }
            try {
              const input = z.object({ file_path: z.string() }).parse(JSON.parse(inputJson));
              observation.responseProbeMatched ||= path.resolve(input.file_path) === probe;
            } catch {
              /* Only a complete, validated tool argument establishes the controlled path. */
            }
            observation.responseTextBytes = Buffer.byteLength(text);
            observation.responseMarkerMatched = text.includes(marker);
          });
          stream.on('error', () => response.destroy());
          stream.pipe(response);
        } catch {
          response.writeHead(502).end();
        }
      })();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Client observation relay could not listen');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    observations,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
