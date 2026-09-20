import { isObjectLike } from 'lodash-es';

const TOOL_ACTIVITY_PART_KEYS = [
  'functionCall',
  'functionResponse',
  'tool_use',
  'tool_result',
] as const;

export interface ToolQuotaRouteInput {
  tools?: readonly unknown[];
  contents?: readonly unknown[];
}

/** Checks whether a request must use the gateway's tool-enabled quota route. */
export function requiresToolQuotaRoute(input: ToolQuotaRouteInput): boolean {
  if ((input.tools?.length ?? 0) > 0) {
    return true;
  }

  return (input.contents ?? []).some((content) => {
    if (!isObjectLike(content)) {
      return false;
    }

    const parts = (content as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) {
      return false;
    }

    return parts.some((part) => {
      return isObjectLike(part) && TOOL_ACTIVITY_PART_KEYS.some((key) => Object.hasOwn(part, key));
    });
  });
}
