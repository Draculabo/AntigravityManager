export const COMMAND_TOOL_CANDIDATES = [
  'local_shell_call',
  'bash',
  'shell',
  'local_shell',
  'powershell',
  'pwsh',
  'terminal',
  'cmd',
  'run_command',
  'execute_command',
] as const;

const COMMAND_TOOL_NAMES = new Set<string>(
  COMMAND_TOOL_CANDIDATES.map((toolName) => toolName.toLowerCase()),
);

const COMMAND_VALUE_ALIASES = ['cmd', 'code', 'script', 'shell_command', 'input'] as const;

/**
 * The receiving process may execute this fallback, so it must remain safe on
 * supported command interpreters and must not imply that a command ran.
 */
export const MISSING_COMMAND_FALLBACK = 'echo "Tool call skipped: no command was provided."';

export interface CommandArgumentAdaptation {
  arguments: Record<string, unknown>;
  fallbackApplied: boolean;
}

export function isCommandExecutionTool(toolName: string): boolean {
  return COMMAND_TOOL_NAMES.has(toolName.toLowerCase());
}

function findDeclaredToolName(
  expectedName: string,
  declaredToolNames: ReadonlySet<string>,
): string | undefined {
  const normalizedExpectedName = expectedName.toLowerCase();
  return [...declaredToolNames].find(
    (declaredToolName) => declaredToolName.toLowerCase() === normalizedExpectedName,
  );
}

export function selectClientCommandTool(
  modelToolName: string,
  clientToolNames: ReadonlySet<string>,
): string {
  if (!isCommandExecutionTool(modelToolName)) {
    return modelToolName;
  }

  const matchingToolName = [modelToolName, ...COMMAND_TOOL_CANDIDATES]
    .map((candidate) => findDeclaredToolName(candidate, clientToolNames))
    .find((candidate): candidate is string => candidate !== undefined);

  return matchingToolName ?? 'local_shell_call';
}

/**
 * Adapts documented command aliases without turning malformed values into
 * executable text. A non-string command remains the caller's responsibility.
 */
export function adaptCommandArguments(
  toolName: string,
  input: Record<string, unknown>,
): CommandArgumentAdaptation {
  if (!isCommandExecutionTool(toolName)) {
    return { arguments: input, fallbackApplied: false };
  }

  const hasCommand = Object.hasOwn(input, 'command');
  const currentCommand = input.command;
  const commandIsBlank =
    hasCommand && typeof currentCommand === 'string' && currentCommand.trim().length === 0;
  if (hasCommand && !commandIsBlank) {
    return { arguments: input, fallbackApplied: false };
  }

  const alias = COMMAND_VALUE_ALIASES.find((candidate) => Object.hasOwn(input, candidate));
  if (!alias) {
    return {
      arguments: { ...input, command: MISSING_COMMAND_FALLBACK },
      fallbackApplied: true,
    };
  }

  const { [alias]: command, ...remaining } = input;
  if (typeof command !== 'string' || command.trim().length > 0) {
    return {
      arguments: { ...remaining, command },
      fallbackApplied: false,
    };
  }

  return {
    arguments: { ...remaining, command: MISSING_COMMAND_FALLBACK },
    fallbackApplied: true,
  };
}
