import { z } from 'zod';

// Bounds the complete encoded request, including UTF-8 text, account selectors and RPC metadata.
export const PLAYGROUND_RPC_MAX_REQUEST_BYTES = 256 * 1024;
// Comparison envelopes repeat the submitted prompt for each account's cURL export.
export const PLAYGROUND_RPC_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Keeps one comparison from turning into an unbounded account-wide probe. */
export const PLAYGROUND_MAX_COMPARE_ACCOUNTS = 8;
/** In-flight requests the comparison path may hold at once. */
export const PLAYGROUND_COMPARE_CONCURRENCY = 4;
/** Matches the maximum accepted by the benchmark controls. */
export const PLAYGROUND_MAX_BENCHMARK_ITERATIONS = 5;

export const PlaygroundPromptPresetSchema = z.strictObject({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(128),
  description: z.string().max(256),
  prompt: z.string().min(1).max(32768),
  systemPrompt: z.string().max(8192).optional(),
});

export type PlaygroundPromptPreset = z.infer<typeof PlaygroundPromptPresetSchema>;

export const PlaygroundReasoningEffortSchema = z.enum(['default', 'off', 'low', 'medium', 'high']);

export type PlaygroundReasoningEffort = z.infer<typeof PlaygroundReasoningEffortSchema>;

export const PlaygroundExecuteInputSchema = z.strictObject({
  accountId: z.string().max(256).optional(),
  model: z.string().min(1).max(256),
  prompt: z.string().min(1).max(32768),
  systemPrompt: z.string().max(8192).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(65536).optional(),
  reasoningEffort: PlaygroundReasoningEffortSchema.optional(),
});

export type PlaygroundExecuteInput = z.infer<typeof PlaygroundExecuteInputSchema>;

export const PlaygroundExecuteResultSchema = z.strictObject({
  request: PlaygroundExecuteInputSchema.optional(),
  success: z.boolean(),
  content: z.string(),
  thinkingContent: z.string().optional(),
  attributedAccountId: z.string().optional(),
  attributedAccountEmail: z.string().optional(),
  model: z.string(),
  durationMs: z.number().nonnegative(),
  /** Request start to the gateway response headers. */
  responseStartedMs: z.number().nonnegative().optional(),
  /** Gateway upstream first byte, when the gateway reported a positive value. */
  upstreamFirstByteMs: z.number().nonnegative().optional(),
  /** Request start to the first reasoning delta. */
  firstReasoningDeltaMs: z.number().nonnegative().optional(),
  /** Request start to the first visible text delta. */
  firstTextDeltaMs: z.number().nonnegative().optional(),
  generationTokensPerSec: z.number().nonnegative().optional(),
  e2eTokensPerSec: z.number().nonnegative().optional(),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  status: z.number().int().min(100).max(599),
  error: z.string().optional(),
});

export type PlaygroundExecuteResult = z.infer<typeof PlaygroundExecuteResultSchema>;

export const PlaygroundCompareInputSchema = z.strictObject({
  accountIds: z.array(z.string().max(256)).min(1).max(PLAYGROUND_MAX_COMPARE_ACCOUNTS),
  model: z.string().min(1).max(256),
  prompt: z.string().min(1).max(32768),
  systemPrompt: z.string().max(8192).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(65536).optional(),
  reasoningEffort: PlaygroundReasoningEffortSchema.optional(),
});

export type PlaygroundCompareInput = z.infer<typeof PlaygroundCompareInputSchema>;

export const PlaygroundCompareResultSchema = z.strictObject({
  results: z.array(PlaygroundExecuteResultSchema),
});

export type PlaygroundCompareResult = z.infer<typeof PlaygroundCompareResultSchema>;
