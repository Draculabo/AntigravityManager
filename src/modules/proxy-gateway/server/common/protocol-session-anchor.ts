import { randomUUID } from 'node:crypto';
import type {
  AnthropicChatRequest,
  GeminiRequest,
  OpenAIChatRequest,
} from './interfaces/request-interfaces';
import { hashSessionAnchor } from './session-anchor-hash';
import {
  anthropicMediaTask,
  geminiMediaTask,
  openAIMediaTask,
  hasOnlySessionFields as onlyKeys,
  type SessionTaskPart,
} from './session-media-anchor';

interface FunctionIdentity {
  name: string;
  description: string;
  parameters: object;
}

interface InstructionIdentity {
  role: string;
  text: string[];
}

export interface SessionAnchorParts {
  taskFingerprint: string;
  contextFingerprint: string;
}

export interface SessionInitialTaskIdentity {
  origin: 'client' | 'content';
  initialTaskFingerprint: string;
}

function compose(parts: SessionAnchorParts, initialTaskFingerprint?: string): string {
  return hashSessionAnchor([
    'task-context:v2',
    initialTaskFingerprint ?? parts.taskFingerprint,
    parts.contextFingerprint,
  ]);
}

function meaningful(text: string[]): boolean {
  return text.some((part) => Boolean(part.trim()));
}

function appendInstruction(
  instructions: InstructionIdentity[],
  role: string,
  text: string[],
): void {
  const previous = instructions.at(-1);
  if (previous?.role === role) {
    for (const part of text) {
      previous.text.push(part);
    }
  } else {
    instructions.push({ role, text });
  }
}

function canonical(
  task: SessionTaskPart[] | undefined,
  instructions: InstructionIdentity[],
  tools: FunctionIdentity[] | undefined,
): SessionAnchorParts | undefined {
  if (task === undefined || tools === undefined) {
    return undefined;
  }
  const containsNonImageMedia = task.some(
    (part) => typeof part !== 'string' && part.kind !== 'inline-image',
  );
  return {
    taskFingerprint: hashSessionAnchor([
      containsNonImageMedia ? 'text-media-task:v1' : 'text-inline-images-task:v2',
      task,
    ]),
    contextFingerprint: hashSessionAnchor(['instructions-functions:v1', instructions, tools]),
  };
}

function chatText(content: OpenAIChatRequest['messages'][number]['content']): string[] | undefined {
  if (typeof content === 'string') {
    return [content];
  }
  if (!content) {
    return [];
  }
  if (content.every((part) => part.type === 'text' && onlyKeys(part, ['type', 'text']))) {
    return content.map((part) => part.text ?? '');
  }
  return undefined;
}

/** Known text/inline images share logical identity; unknown shapes remain protocol scoped. */
export function findOpenAIInitialTask(
  request: OpenAIChatRequest,
): OpenAIChatRequest['messages'][number] | undefined {
  return request.messages.find((message) => {
    const text = chatText(message.content);
    return message.role === 'user' && (text === undefined || meaningful(text));
  });
}

export function openAISessionAnchorParts(request: OpenAIChatRequest): SessionAnchorParts {
  const firstUser = findOpenAIInitialTask(request);
  const initial: OpenAIChatRequest['messages'] = [];
  for (const message of request.messages) {
    if (message.role === 'system' || message.role === 'developer') {
      initial.push(message);
    } else if (message.role !== 'user' || meaningful(chatText(message.content) ?? ['media'])) {
      break;
    }
  }
  const instructions: InstructionIdentity[] = [];
  let known = Boolean(firstUser && onlyKeys(firstUser, ['role', 'content']));
  for (const message of initial) {
    const text = chatText(message.content);
    if (text === undefined || !onlyKeys(message, ['role', 'content'])) {
      known = false;
    } else {
      appendInstruction(instructions, message.role, text);
    }
  }
  const tools: FunctionIdentity[] = [];
  for (const tool of request.tools ?? []) {
    const fn = tool.function;
    if (
      tool.type !== 'function' ||
      !fn ||
      !onlyKeys(tool, ['type', 'function']) ||
      !onlyKeys(fn, ['name', 'description', 'parameters'])
    ) {
      known = false;
    } else {
      tools.push({
        name: fn.name,
        description: fn.description ?? '',
        parameters: fn.parameters ?? {},
      });
    }
  }
  return (
    (known
      ? canonical(openAIMediaTask(firstUser?.content ?? null), instructions, tools)
      : undefined) ?? {
      taskFingerprint: hashSessionAnchor([
        'openai-task:v2',
        firstUser ?? (request.messages.length ? request.messages : randomUUID()),
      ]),
      contextFingerprint: hashSessionAnchor(['openai-context:v2', initial, request.tools ?? []]),
    }
  );
}

export function openAISessionAnchor(
  request: OpenAIChatRequest,
  initialTaskFingerprint?: string,
): string {
  return compose(openAISessionAnchorParts(request), initialTaskFingerprint);
}

export function anthropicSessionAnchor(request: AnthropicChatRequest): string {
  const firstUser = request.messages.find(
    (message) =>
      message.role === 'user' &&
      (typeof message.content === 'string'
        ? Boolean(message.content.trim())
        : message.content.some(
            (block) =>
              block.type !== 'tool_result' && (block.type !== 'text' || Boolean(block.text.trim())),
          )),
  );
  const task =
    typeof firstUser?.content === 'string'
      ? firstUser.content
      : firstUser?.content.filter((block) => block.type !== 'tool_result');
  const system =
    typeof request.system === 'string'
      ? [{ type: 'text', text: request.system }]
      : (request.system ?? []);
  const text = anthropicMediaTask(task);
  const knownSystem = system.every(
    (block) => block.type === 'text' && onlyKeys(block, ['type', 'text']),
  );
  const tools: FunctionIdentity[] = [];
  let known = knownSystem && Boolean(firstUser && onlyKeys(firstUser, ['role', 'content']));
  for (const tool of request.tools ?? []) {
    if (!onlyKeys(tool, ['name', 'description', 'input_schema'])) {
      known = false;
    } else {
      tools.push({
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.input_schema ?? {},
      });
    }
  }
  const instructions: InstructionIdentity[] = system.length
    ? [{ role: 'system', text: system.map((block) => block.text) }]
    : [];
  return compose(
    (known ? canonical(text, instructions, tools) : undefined) ?? {
      taskFingerprint: hashSessionAnchor([
        'anthropic-task:v2',
        firstUser
          ? { ...firstUser, content: task }
          : request.messages.length
            ? request.messages
            : randomUUID(),
      ]),
      contextFingerprint: hashSessionAnchor([
        'anthropic-context:v2',
        request.system ?? null,
        request.tools ?? [],
      ]),
    },
  );
}

export function geminiSessionAnchor(request: GeminiRequest): string {
  const isToolResult = (part: GeminiRequest['contents'][number]['parts'][number]) =>
    Boolean(part.functionResponse) &&
    onlyKeys(part, ['functionResponse', 'thoughtSignature', 'thought_signature']);
  const firstUser = request.contents.find(
    (content) =>
      content.role === 'user' &&
      content.parts.some(
        (part) => !isToolResult(part) && (part.text === undefined || Boolean(part.text.trim())),
      ),
  );
  const parts = firstUser?.parts.filter((part) => !isToolResult(part));
  const system = request.systemInstruction?.parts ?? [];
  const textOnly = (part: NonNullable<typeof parts>[number]) =>
    typeof part.text === 'string' && onlyKeys(part, ['text']);
  let known =
    Boolean(firstUser && onlyKeys(firstUser, ['role', 'parts'])) &&
    system.every(textOnly) &&
    (!request.systemInstruction || onlyKeys(request.systemInstruction, ['parts']));
  const text = geminiMediaTask(parts);
  const tools: FunctionIdentity[] = [];
  for (const declaration of request.tools ?? []) {
    if (!onlyKeys(declaration, ['functionDeclarations'])) {
      known = false;
    }
    for (const fn of declaration.functionDeclarations ?? []) {
      if (!onlyKeys(fn, ['name', 'description', 'parameters'])) {
        known = false;
      }
      tools.push({
        name: fn.name,
        description: fn.description ?? '',
        parameters: fn.parameters ?? {},
      });
    }
  }
  const instructions: InstructionIdentity[] = system.length
    ? [{ role: 'system', text: system.map((part) => part.text ?? '') }]
    : [];
  return compose(
    (known ? canonical(text, instructions, tools) : undefined) ?? {
      taskFingerprint: hashSessionAnchor([
        'gemini-task:v2',
        firstUser
          ? { ...firstUser, parts }
          : request.contents.length
            ? request.contents
            : randomUUID(),
      ]),
      contextFingerprint: hashSessionAnchor([
        'gemini-context:v2',
        request.systemInstruction ?? null,
        request.tools ?? [],
      ]),
    },
  );
}
