const RETIRED_MODEL_IDS = new Set(['gemini-pro-agent', 'gemini-3.1-pro-high']);

export function isRetiredModel(model: string): boolean {
  return RETIRED_MODEL_IDS.has(
    model
      .trim()
      .replace(/^models\//i, '')
      .toLowerCase(),
  );
}
