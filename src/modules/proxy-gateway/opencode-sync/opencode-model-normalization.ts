export const OPEN_CODE_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'gemini-3.1-pro-high': 'gemini-3.1-pro',
  'gemini-3.1-pro-low': 'gemini-3.1-pro',
  'gemini-pro': 'gemini-3.1-pro',
  'gemini-3.5-flash-high': 'gemini-3.5-flash',
  'gemini-3.5-flash-medium': 'gemini-3.5-flash',
  'gemini-3.5-flash-low': 'gemini-3.5-flash',
  'gemini-3-flash': 'gemini-3.5-flash',
};

const OPEN_CODE_CANONICAL_MODEL_NAMES: Readonly<Record<string, string>> = {
  'gemini-3.1-pro': 'Gemini 3.1 Pro',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
};

export function canonicalizeOpenCodeModelId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  return OPEN_CODE_MODEL_ALIASES[normalized] ?? normalized;
}

export function getOpenCodeModelDisplayName(modelId: string, fallbackName: string): string {
  return OPEN_CODE_CANONICAL_MODEL_NAMES[canonicalizeOpenCodeModelId(modelId)] ?? fallbackName;
}
