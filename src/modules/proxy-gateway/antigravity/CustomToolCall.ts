const APPLY_PATCH_TOOL_NAMES = new Set(['apply_patch', 'apply_patch_v2']);

export function isCustomToolCall(name: string): boolean {
  return APPLY_PATCH_TOOL_NAMES.has(name);
}

export function extractCustomToolInput(name: string, args: Record<string, unknown>): string {
  if (!isCustomToolCall(name)) {
    return JSON.stringify(args);
  }

  const command = args.command;
  if (Array.isArray(command) && typeof command[1] === 'string') {
    return command[1];
  }

  if (typeof command === 'string') {
    if (command.startsWith('apply_patch\n')) {
      return command.slice('apply_patch\n'.length);
    }
    if (command.startsWith('apply_patch ')) {
      return command.slice('apply_patch '.length);
    }
    return command;
  }

  for (const field of ['patch_text', 'input', 'patch', 'diff', 'content']) {
    const value = args[field];
    if (typeof value === 'string') {
      return value;
    }
  }

  return JSON.stringify(args);
}

export function toCustomToolArguments(name: string, input: string): Record<string, unknown> {
  if (isCustomToolCall(name)) {
    return {
      input,
    };
  }

  return {
    input,
  };
}
