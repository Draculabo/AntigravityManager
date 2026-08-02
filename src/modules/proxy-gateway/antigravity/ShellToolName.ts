const SHELL_TOOL_NAMES = new Set(['shell', 'bash', 'local_shell', 'local_shell_call']);
const SHELL_TOOL_PRIORITY = ['local_shell_call', 'bash', 'shell', 'local_shell'] as const;

export function resolveShellToolName(
  modelToolName: string,
  clientToolNames: ReadonlySet<string>,
): string {
  if (!SHELL_TOOL_NAMES.has(modelToolName)) {
    return modelToolName;
  }
  if (clientToolNames.has(modelToolName)) {
    return modelToolName;
  }

  for (const candidate of SHELL_TOOL_PRIORITY) {
    if (clientToolNames.has(candidate)) {
      return candidate;
    }
  }

  return 'local_shell_call';
}
