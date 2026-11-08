import { BadRequestException } from '@nestjs/common';
import type { GeminiToolConfig } from './types';

const GOOGLE_SEARCH_TOOL_TYPES = new Set([
  'web_search_20250305',
  'google_search',
  'google_search_retrieval',
  'builtin_web_search',
]);

type ToolConfigurationFailure =
  | 'unsupported-choice'
  | 'missing-function-name'
  | 'unknown-function-name'
  | 'required-without-functions'
  | 'required-with-json-schema'
  | 'mixed-search-and-function-tools';

interface ToolChoiceDeclaration {
  name?: string;
  type?: string;
}

const TOOL_CONFIGURATION_FAILURE_MESSAGES: Record<ToolConfigurationFailure, string> = {
  'unsupported-choice':
    'Unsupported tool_choice. Use auto, none, any, required, or a named declared function.',
  'missing-function-name': 'A named tool_choice must include a function name.',
  'unknown-function-name': 'tool_choice refers to a function that is not declared in this request.',
  'required-without-functions': 'tool_choice requires a function, but this request declares none.',
  'required-with-json-schema':
    'This upstream path cannot require a tool call with Responses json_schema. Call the tool in a separate request or remove json_schema.',
  'mixed-search-and-function-tools':
    'This upstream path cannot combine Google Search with function declarations in one request.',
};

export class ToolConfigurationError extends BadRequestException {
  constructor(readonly reason: ToolConfigurationFailure) {
    super(TOOL_CONFIGURATION_FAILURE_MESSAGES[reason]);
    this.name = 'ToolConfigurationError';
  }
}

export function isGoogleSearchToolType(type: unknown): boolean {
  return typeof type === 'string' && GOOGLE_SEARCH_TOOL_TYPES.has(type.toLowerCase());
}

/**
 * Preserve only a client-specified function choice. Google Search is a distinct
 * server-side tool and is never inferred from an ordinary function's name.
 */
export function buildToolConfig(
  toolChoice: unknown,
  tools: readonly ToolChoiceDeclaration[],
): GeminiToolConfig {
  const functionNames = new Set<string>();
  let hasGoogleSearch = false;

  for (const tool of tools) {
    if (isGoogleSearchToolType(tool.type)) {
      hasGoogleSearch = true;
      continue;
    }
    if (typeof tool.name === 'string' && tool.name.length > 0) {
      functionNames.add(tool.name);
    }
  }

  if (hasGoogleSearch && functionNames.size > 0) {
    throw new ToolConfigurationError('mixed-search-and-function-tools');
  }

  const functionCallingConfig = resolveFunctionCallingConfig(toolChoice, functionNames);
  return {
    ...(functionCallingConfig === undefined ? {} : { functionCallingConfig }),
    includeServerSideToolInvocations: true,
  };
}

function resolveFunctionCallingConfig(
  toolChoice: unknown,
  functionNames: ReadonlySet<string>,
): GeminiToolConfig['functionCallingConfig'] | undefined {
  if (toolChoice === undefined) {
    return undefined;
  }

  let choice: unknown = toolChoice;
  let selectedName: unknown;
  if (typeof toolChoice === 'object' && toolChoice !== null && !Array.isArray(toolChoice)) {
    choice = Reflect.get(toolChoice, 'type');
    if (choice === 'tool') {
      selectedName = Reflect.get(toolChoice, 'name');
    } else if (choice === 'function') {
      const functionChoice = Reflect.get(toolChoice, 'function');
      if (typeof functionChoice === 'object' && functionChoice !== null) {
        selectedName = Reflect.get(functionChoice, 'name');
      }
    }
  }

  switch (choice) {
    case 'auto':
      return { mode: 'AUTO' };
    case 'none':
      return { mode: 'NONE' };
    case 'any':
    case 'required':
      if (functionNames.size === 0) {
        throw new ToolConfigurationError('required-without-functions');
      }
      return { mode: 'ANY' };
    case 'tool':
    case 'function':
      if (typeof selectedName !== 'string' || selectedName.length === 0) {
        throw new ToolConfigurationError('missing-function-name');
      }
      if (!functionNames.has(selectedName)) {
        throw new ToolConfigurationError('unknown-function-name');
      }
      return { mode: 'ANY', allowedFunctionNames: [selectedName] };
    default:
      throw new ToolConfigurationError('unsupported-choice');
  }
}
