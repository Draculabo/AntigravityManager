import type { GlobalSystemPromptConfig } from '@/modules/config/types';

/**
 * Preserve the configured text; the owning mapper adds its explicit section boundary.
 */
export function resolveGlobalSystemPrompt(
  config: GlobalSystemPromptConfig | undefined,
): string | null {
  if (!config?.enabled) {
    return null;
  }

  return config.content.trim() ? config.content : null;
}

export function formatGlobalSystemPrompt(globalPrompt: string): string {
  return `<global_system_prompt>\n${globalPrompt}\n</global_system_prompt>`;
}
