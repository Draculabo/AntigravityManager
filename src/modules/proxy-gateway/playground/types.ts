export interface PromptPreset {
  id: string;
  titleKey: string;
  promptKey: string;
  systemPrompt?: string;
}

export const PLAYGROUND_PRESETS: PromptPreset[] = [
  {
    id: 'hello',
    titleKey: 'playground.presets.hello',
    promptKey: 'playground.preset-prompts.hello',
  },
  {
    id: 'reasoning',
    titleKey: 'playground.presets.reasoning',
    promptKey: 'playground.preset-prompts.reasoning',
  },
  {
    id: 'identity',
    titleKey: 'playground.presets.identity',
    promptKey: 'playground.preset-prompts.identity',
  },
  {
    id: 'code',
    titleKey: 'playground.presets.code',
    promptKey: 'playground.preset-prompts.code',
  },
];

export const DEFAULT_PLAYGROUND_MODELS = [
  { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)', family: 'gemini' },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', family: 'gemini' },
  { id: 'gemini-3.7-pro', name: 'Gemini 3.7 Pro', family: 'gemini' },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', family: 'claude' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', family: 'claude' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', family: 'claude' },
] as const;

export type BenchmarkItemStatus = 'idle' | 'running' | 'success' | 'error' | 'skipped';

export interface BenchmarkModelRow {
  modelId: string;
  modelName: string;
  quotaPercentage?: number;
  status: BenchmarkItemStatus;
  durationMs?: number;
  ttftMs?: number;
  generationTokensPerSec?: number;
  e2eTokensPerSec?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  httpStatus?: number;
  content?: string;
  thinkingContent?: string;
  error?: string;
}
