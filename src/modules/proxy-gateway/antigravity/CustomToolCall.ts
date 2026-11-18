import type { OpenAITool } from '../../../server/gateway/common/interfaces/request-interfaces';
import { flattenOpenAITools, getOpenAIToolName } from './ToolNamespace';

export function isDeclaredOpenAICustomTool(name: string, tools: OpenAITool[] | undefined): boolean {
  const declaration = flattenOpenAITools(tools)?.find((tool) => getOpenAIToolName(tool) === name);
  return declaration?.type === 'custom';
}

/** Read the freeform input envelope used by the upstream function declaration. */
export function readCustomToolInput(args: Record<string, unknown>): string {
  return typeof args.input === 'string' ? args.input : JSON.stringify(args);
}
