export interface PromptPreset {
  id: string;
  titleKey: string;
  prompt: string;
  systemPrompt?: string;
}

export const PLAYGROUND_PRESETS: PromptPreset[] = [
  {
    id: 'hello',
    titleKey: 'playground.presets.hello',
    prompt: 'Say hello, state your model name, and summarize your purpose in one short sentence.',
  },
  {
    id: 'reasoning',
    titleKey: 'playground.presets.reasoning',
    prompt:
      'There are 3 apples on a table. You take away 2. How many apples do you have? Think step by step.',
  },
  {
    id: 'identity',
    titleKey: 'playground.presets.identity',
    prompt: 'What is your exact model version, knowledge cutoff date, and provider?',
  },
  {
    id: 'code',
    titleKey: 'playground.presets.code',
    prompt: 'Write a TypeScript debounce function with proper generics and clearTimeout.',
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
