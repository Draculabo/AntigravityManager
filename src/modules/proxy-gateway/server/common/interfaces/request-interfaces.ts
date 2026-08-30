import type { GeminiToolConfig, GeminiToolDeclaration } from '../../../antigravity/types';

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  max_tokens?: number;
  stream?: boolean;
  /** Ask the gateway to keep the completion so its GET route can replay it. */
  store?: boolean;
  size?: string;
  quality?: string;
  tools?: OpenAITool[];
  tool_choice?: string | { type: string; function?: { name: string } };
  thinking?: OpenAIThinkingConfig;
  reasoning_effort?: string;
  response_format?: { type?: string };
  extra?: Record<string, unknown>;
}

export interface OpenAIThinkingConfig {
  type?: string;
  budget_tokens?: number;
  effort?: string;
}

export interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentPart[] | null;
  refusal?: string;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
  };
}

export interface OpenAITool {
  type: string;
  name?: string;
  tools?: OpenAITool[];
  function?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function' | 'apply_patch_call' | string;
  function?: {
    name: string;
    arguments: string;
  };
  status?: string;
  call_id?: string;
  operation?: {
    type: string;
    diff: string;
    path: string;
  };
  /**
   * Preserves Responses custom tool payloads such as apply_patch without
   * forcing format-sensitive input through the normal JSON arguments path.
   */
  custom_input?: string;
  namespace?: string;
}

export interface AnthropicChatRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  max_tokens?: number;
  tools?: AnthropicTool[];
  thinking?: AnthropicThinkingConfig;
  output_config?: AnthropicOutputConfig;
  metadata?: Record<string, unknown>;
  stop_sequences?: string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tool_choice?: string | { type: string; name?: string; function?: { name: string } };
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
}

export interface AnthropicOutputConfig {
  effort?: string;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  type?: string;
}

export interface AnthropicThinkingConfig {
  type: 'enabled' | string;
  budget_tokens?: number;
}

export interface AnthropicMessage {
  role: string;
  content: string | AnthropicContent[];
}

export interface AnthropicSystemBlock {
  type: string;
  text: string;
}

export type AnthropicContent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'image'; source: AnthropicImageSource }
  // A document is an image block by another name on the wire: same inline
  // source, and the upstream transport has one representation for both.
  | { type: 'document'; source: AnthropicImageSource; title?: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      signature?: string;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string | AnthropicContent[];
      is_error?: boolean;
    }
  | { type: 'redacted_thinking'; data: string };

export interface AnthropicImageSource {
  type: 'base64';
  media_type: string;
  data: string;
}

export interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

export interface GeminiPart {
  text?: string;
  inlineData?: GeminiInlineData;
  thoughtSignature?: string;
  thought_signature?: string;
}

export interface GeminiInlineData {
  mimeType: string;
  data: string;
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: GeminiGenerationConfig;
  tools?: GeminiToolDeclaration[];
  toolConfig?: GeminiToolConfig;
}

export interface GeminiGenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
}

export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  promptFeedback?: {
    blockReason?: string;
    blockReasonMessage?: string;
  };
}

export interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
  index?: number;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cached_tokens?: number;
  total_thought_tokens?: number;
  totalThoughtTokens?: number;
  total_tokens?: number;
  total_tool_use_tokens?: number;
  cachedTokens?: number;
  promptTokensDetails?: Array<{
    modality?: string;
    tokenCount?: number;
  }>;
  candidatesTokensDetails?: Array<{
    modality?: string;
    tokenCount?: number;
  }>;
  trafficType?: string;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage: OpenAIUsage;
}

export interface OpenAIChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[];
    reasoning_content?: string;
    refusal?: string;
  };
  finish_reason: string | null;
}

export interface AnthropicChatResponse {
  id: string;
  type: string;
  role: string;
  model: string;
  content: AnthropicContent[];
  stop_reason: string | null;
  stop_sequence?: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}
