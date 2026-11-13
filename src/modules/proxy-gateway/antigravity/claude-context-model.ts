/** Claude Code's context suffix is a client hint; the resolved model owns its actual limits. */
export function normalizeClaudeContextModel(model: string): string {
  if (!/^(?:anthropic\/)?claude-/i.test(model)) {
    return model;
  }
  return model.replace(/^anthropic\//i, '').replace(/\[(?:1m|200k|128k)\]$/i, '');
}
