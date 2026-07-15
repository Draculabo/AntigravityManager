export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  size?: string;
  quality?: string;
  tools?: OpenAITool[];
  tool_choice?: string | { type: string; function?: { name: string } };
  response_format?: { type?: string };
  extra?: Record<string, unknown>;
}

export interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentPart[];
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
  function?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AnthropicChatRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  max_tokens?: number;
  tools?: AnthropicTool[];
  thinking?: AnthropicThinkingConfig;
  metadata?: Record<string, unknown>;
  stop_sequences?: string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
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
  thoughtsTokenCount?: number;
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

export interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[];
    reasoning_content?: string;
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
