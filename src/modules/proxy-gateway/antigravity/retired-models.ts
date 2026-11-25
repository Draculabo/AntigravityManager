import { normalizeClaudeContextModel } from './claude-context-model';

const RETIRED_MODEL_IDS = new Set(['gemini-pro-agent', 'gemini-3.1-pro-high']);

export function isRetiredModel(model: string): boolean {
  const id = normalizeClaudeContextModel(
    model
      .trim()
      .toLowerCase()
      .replace(/^models\//, ''),
  );
  if (RETIRED_MODEL_IDS.has(id) || id.endsWith('-disabled')) {
    return true;
  }
  if (/^gemini-(?:1|2)(?:[.-]|$)/.test(id)) {
    return !/(?:^|-)image(?:-|$)/.test(id);
  }
  const claudeVersion =
    /^claude-(?:(?:opus|sonnet|haiku|fable|mythos)-)?(\d+)(?:[.-](\d{1,2})(?=-|$))?(?:[.-]|$)/.exec(
      id,
    );
  if (!claudeVersion) {
    return false;
  }
  const major = Number(claudeVersion[1]);
  return major < 4 || (major === 4 && Number(claudeVersion[2] ?? 0) < 6);
}
