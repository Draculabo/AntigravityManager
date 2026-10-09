import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { z } from 'zod';

// A test-owned stdio MCP tool: it reads one fixed probe and exposes no shell or arbitrary path.
const file = fs.realpathSync.native(z.string().parse(process.argv[2]));
if (
  path.basename(file) !== 'probe.txt' ||
  !path.basename(path.dirname(path.dirname(file))).startsWith('agm-client-matrix-')
) {
  throw new Error('Probe is outside the owned client test directory');
}
const Request = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (Buffer.byteLength(line) > 65_536) {
    process.exitCode = 1;
    lines.close();
    break;
  }
  const request = Request.parse(JSON.parse(line));
  if (request.id === undefined) {
    continue;
  }
  let result;
  let error;
  if (request.method === 'initialize') {
    const params = z.object({ protocolVersion: z.string() }).parse(request.params);
    result = {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'controlled-probe', version: '1.0.0' },
    };
  } else if (request.method === 'tools/list') {
    result = {
      tools: [
        {
          name: 'read_probe',
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          description:
            'Read the controlled probe.txt file once. No other file access is available.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    };
  } else if (request.method === 'tools/call') {
    const call = z
      .object({ name: z.literal('read_probe'), arguments: z.object({}).strict().optional() })
      .safeParse(request.params);
    result = call.success
      ? { content: [{ type: 'text', text: fs.readFileSync(file, 'utf8') }] }
      : {
          isError: true,
          content: [{ type: 'text', text: 'Only the fixed read-only probe tool is available.' }],
        };
  } else if (request.method === 'ping') {
    result = {};
  } else {
    error = { code: -32601, message: 'Method not supported by the controlled probe server' };
  }
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) })}\n`,
  );
}
