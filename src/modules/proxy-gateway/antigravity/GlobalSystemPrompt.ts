import type { GlobalSystemPromptConfig } from '@/modules/config/types';

/**
 * Resolves the optional user-configured instruction without carrying whitespace
 * that could collapse the boundary between prompt sections upstream.
 */
export function resolveGlobalSystemPrompt(
  config: GlobalSystemPromptConfig | undefined,
): string | null {
  if (!config?.enabled) {
    return null;
  }

  const content = config.content.trim();
  return content || null;
}

/**
 * The provider treats all system-instruction parts as one prompt. Avoid a
 * second global copy when a native client already supplied it in a text part.
 */
export function hasGlobalSystemPrompt(
  parts: ReadonlyArray<{ text: string }>,
  globalPrompt: string,
): boolean {
  return parts.some((part) => part.text.includes(globalPrompt));
}

export function formatGlobalSystemPrompt(globalPrompt: string): string {
  return `${globalPrompt}\n\n`;
}
