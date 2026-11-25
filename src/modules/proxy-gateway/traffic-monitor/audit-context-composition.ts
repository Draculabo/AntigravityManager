import { z } from 'zod';

export const contextParts = [
  'system',
  'tools',
  'skills',
  'memory',
  'attachments',
  'results',
  'conversation',
] as const;
type ContextPart = (typeof contextParts)[number];
const object = z.record(z.string(), z.unknown());
const encoder = new TextEncoder();

export function readAuditContextComposition(text: string): Record<ContextPart, number> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const root = object.safeParse(parsed);
  if (!root.success) {
    return null;
  }
  const nested = object.safeParse(root.data.request);
  const body = nested.success ? nested.data : root.data;
  const groups = {
    system: 0,
    tools: 0,
    skills: 0,
    memory: 0,
    attachments: 0,
    results: 0,
    conversation: 0,
  };
  const add = (part: ContextPart, value: unknown) => {
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0)
    ) {
      return;
    }
    groups[part] += encoder.encode(JSON.stringify(value)).byteLength;
  };

  function addContent(value: unknown, fallback: ContextPart) {
    if (!Array.isArray(value)) {
      add(fallback, value);
      return;
    }
    for (const part of value) {
      const block = object.safeParse(part);
      if (!block.success) {
        add(fallback, part);
      } else if (
        block.data.type === 'tool_result' ||
        block.data.type === 'function_call_output' ||
        block.data.type === 'custom_tool_call_output' ||
        block.data.functionResponse !== undefined
      ) {
        add('results', part);
      } else if (
        (typeof block.data.type === 'string' &&
          /^(?:input_)?(?:image|file|audio|document)/u.test(block.data.type)) ||
        block.data.inlineData !== undefined ||
        block.data.fileData !== undefined ||
        block.data.inline_data !== undefined ||
        block.data.file_data !== undefined
      ) {
        add('attachments', part);
      } else {
        add(fallback, part);
      }
    }
  }

  add('system', body.system);
  add('system', body.instructions);
  add('system', body.systemInstruction ?? body.system_instruction);
  add('tools', body.tools ?? body.functions);
  add('skills', body.skills);
  add('memory', body.memory);
  add('attachments', body.attachments);
  const messages = body.messages ?? body.input ?? body.contents ?? body.prompt;
  if (Array.isArray(messages)) {
    for (const entry of messages) {
      const message = object.safeParse(entry);
      if (!message.success) {
        add('conversation', entry);
        continue;
      }
      const { role, type, content, parts } = message.data;
      if (role === 'system' || role === 'developer') {
        addContent(content ?? parts, 'system');
      } else if (
        role === 'tool' ||
        role === 'function' ||
        type === 'function_call_output' ||
        type === 'custom_tool_call_output'
      ) {
        add('results', content ?? parts ?? message.data.output);
      } else {
        addContent(content ?? parts ?? [message.data], 'conversation');
      }
    }
  } else {
    add('conversation', messages);
  }
  return Object.values(groups).some((bytes) => bytes > 0) ? groups : null;
}
