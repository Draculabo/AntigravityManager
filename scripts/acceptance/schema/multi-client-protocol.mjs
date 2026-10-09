import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';

const Tool = z.object({
  type: z.string().optional(),
  name: z.string().optional(),
  input_schema: z.unknown().optional(),
  parameters: z.unknown().optional(),
  function: z.object({ name: z.string(), parameters: z.unknown().optional() }).optional(),
  tools: z.array(z.unknown()).max(128).optional(),
});
const Request = z.object({ tools: z.array(z.unknown()).max(128).optional() });

/** Measure declarations emitted by the client; never alter the forwarded request. */
export function clientSchemaMetrics(body, measureSchemas) {
  const root = Request.parse(body);
  const schemas = [];
  let nonSchemaTools = 0;
  function visit(values, depth = 0) {
    if (depth > 8) {
      throw new Error('Client tool namespaces exceeded their bound');
    }
    for (const value of values) {
      const tool = Tool.parse(value);
      if (tool.type === 'namespace' && tool.tools) {
        visit(tool.tools, depth + 1);
      } else if (tool.function || tool.type === 'function' || tool.input_schema !== undefined) {
        schemas.push({
          name: tool.function?.name ?? tool.name ?? '',
          input_schema: tool.function?.parameters ?? tool.input_schema ?? tool.parameters,
        });
      } else {
        nonSchemaTools++;
      }
      if (schemas.length + nonSchemaTools > 128) {
        throw new Error('Client tool declarations exceeded their bound');
      }
    }
  }
  visit(root.tools ?? []);
  return { ...measureSchemas(schemas), nonSchemaTools };
}

const Content = z.object({
  type: z.string().optional(),
  role: z.string().optional(),
  content: z.unknown().optional(),
  output: z.unknown().optional(),
});
export function requestToolResultMatches(body, marker) {
  const request = z
    .object({ messages: z.array(z.unknown()).optional(), input: z.unknown().optional() })
    .parse(body);
  for (const raw of [
    ...(request.messages ?? []),
    ...(Array.isArray(request.input) ? request.input : []),
  ]) {
    const item = Content.safeParse(raw);
    if (!item.success) {
      continue;
    }
    if (
      (item.data.role === 'tool' || item.data.type === 'function_call_output') &&
      JSON.stringify(item.data.output ?? item.data.content ?? '').includes(marker)
    ) {
      return true;
    }
    if (item.data.role === 'user' && Array.isArray(item.data.content)) {
      for (const block of item.data.content) {
        const result = Content.safeParse(block);
        if (
          result.success &&
          result.data.type === 'tool_result' &&
          JSON.stringify(result.data.content ?? '').includes(marker)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

const Function = z.object({ name: z.string().optional(), arguments: z.string().optional() });
const Item = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  name: z.string().optional(),
  namespace: z.string().optional(),
  arguments: z.string().optional(),
  input: z.unknown().optional(),
});
const Event = z.object({
  type: z.string().optional(),
  item: Item.optional(),
  index: z.number().optional(),
  content_block: Item.optional(),
  delta: z.union([z.string(), z.object({ partial_json: z.string().optional() })]).optional(),
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            tool_calls: z
              .array(z.object({ index: z.number(), function: Function.optional() }))
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

/** Buffer the bounded acceptance response so unsafe tool instructions never reach the CLI. */
export function responseToolCalls(text) {
  const calls = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') {
      continue;
    }
    const event = Event.parse(JSON.parse(line.slice(6)));
    const item = event.item;
    if (item && ['function_call', 'custom_tool_call'].includes(item.type ?? '')) {
      const key = item.id ?? `response-${calls.size}`;
      const previous = calls.get(key);
      calls.set(key, {
        name:
          item.namespace && item.name
            ? `${item.namespace}__${item.name}`
            : (item.name ?? previous?.name),
        arguments:
          item.arguments ??
          (typeof item.input === 'string' ? item.input : (previous?.arguments ?? '')),
      });
    }
    if (event.content_block?.type === 'tool_use') {
      calls.set(`anthropic-${event.index}`, {
        name: event.content_block.name,
        arguments: JSON.stringify(event.content_block.input ?? {}),
      });
    }
    if (typeof event.delta !== 'string' && event.delta?.partial_json) {
      const call = calls.get(`anthropic-${event.index}`);
      if (call) {
        if (call.arguments === '{}') {
          call.arguments = '';
        }
        call.arguments += event.delta.partial_json;
      }
    }
    for (const choice of event.choices ?? []) {
      for (const part of choice.delta?.tool_calls ?? []) {
        const key = `chat-${part.index}`;
        const call = calls.get(key) ?? { name: undefined, arguments: '' };
        call.name ??= part.function?.name;
        call.arguments += part.function?.arguments ?? '';
        calls.set(key, call);
      }
    }
  }
  return [...calls.values()];
}

function sameExistingPath(actual, expected) {
  // Handle-resolved paths identify the same Windows file through short/long path aliases.
  try {
    const first = fs.realpathSync.native(actual);
    const second = fs.realpathSync.native(expected);
    return process.platform === 'win32'
      ? first.toLowerCase() === second.toLowerCase()
      : first === second;
  } catch {
    return false;
  }
}

export function toolCallsAreReadOnly(calls, directory) {
  return calls.every((call) => {
    const name = call.name?.split('.').at(-1);
    let raw;
    try {
      raw = JSON.parse(call.arguments);
    } catch {
      return false;
    }
    if (name === 'mcp__probe__read_probe') {
      return z.object({}).strict().safeParse(raw).success;
    }
    const args = z
      .object({
        file_path: z.string().optional(),
        filePath: z.string().optional(),
        path: z.string().optional(),
        command: z.string().optional(),
        cmd: z.string().optional(),
        pattern: z.string().optional(),
        sandbox_permissions: z.string().optional(),
        workdir: z.string().optional(),
        cwd: z.string().optional(),
        shell: z.string().optional(),
        login: z.boolean().optional(),
      })
      .safeParse(raw);
    if (!args.success || args.data.sandbox_permissions === 'require_escalated') {
      return false;
    }
    if (['shell_command', 'exec_command'].includes(name)) {
      const workingDirectory = args.data.workdir ?? args.data.cwd ?? directory;
      const expectedShell = path.win32.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      );
      return (
        args.data.login === false &&
        sameExistingPath(path.resolve(directory, workingDirectory), directory) &&
        (args.data.shell === undefined ||
          path.win32.normalize(args.data.shell).toLowerCase() === expectedShell.toLowerCase()) &&
        [
          'Get-Content -LiteralPath ./probe.txt',
          'Get-Content -LiteralPath .\\probe.txt',
          'Get-Content -LiteralPath probe.txt',
        ].includes(args.data.command ?? args.data.cmd ?? '')
      );
    }
    if (['Read', 'read'].includes(name)) {
      const file = args.data.file_path ?? args.data.filePath;
      return (
        typeof file === 'string' &&
        sameExistingPath(path.resolve(directory, file), path.join(directory, 'probe.txt'))
      );
    }
    if (['Glob', 'glob', 'Grep', 'grep'].includes(name)) {
      const location = path.resolve(directory, args.data.path ?? '.');
      return (
        [directory, path.join(directory, 'probe.txt')].some((expected) =>
          sameExistingPath(location, expected),
        ) && args.data.pattern !== undefined
      );
    }
    return false;
  });
}

export function clientFinalMatches(client, stdout, marker) {
  for (const line of stdout.split(/\r?\n/)) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const value = z
      .object({
        type: z.string(),
        result: z.string().optional(),
        is_error: z.boolean().optional(),
        item: z.object({ type: z.string(), text: z.string().optional() }).optional(),
        part: z.object({ type: z.string(), text: z.string().optional() }).optional(),
      })
      .safeParse(raw);
    if (!value.success) {
      continue;
    }
    const event = value.data;
    if (
      client === 'codex' &&
      event.type === 'item.completed' &&
      event.item?.type === 'agent_message' &&
      event.item.text?.includes(marker)
    ) {
      return true;
    }
    if (client === 'opencode' && event.type === 'text' && event.part?.text?.includes(marker)) {
      return true;
    }
    if (
      client === 'claude' &&
      event.type === 'result' &&
      event.is_error !== true &&
      event.result?.includes(marker)
    ) {
      return true;
    }
  }
  return false;
}

export function clientEvidencePasses(evidence) {
  return (
    evidence.exit === 0 &&
    evidence.finalMatched === true &&
    evidence.observations.length >= 2 &&
    evidence.observations.every((item) => item.status === 200 && item.safeTools === true) &&
    evidence.observations.some((item) => item.toolCalls > 0) &&
    evidence.observations.some((item) => item.toolResultMatched === true) &&
    evidence.observations.some(
      (item) => item.schemas.schemas > 0 && item.schemas.degraded === false,
    )
  );
}
