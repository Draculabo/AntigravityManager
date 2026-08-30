// ============================================================================
// Common Types (Shared types used across multiple interfaces)
// ============================================================================

/**
 * Cache Control Configuration
 * Controls caching behavior of content blocks
 */
export interface CacheControl {
  /** Cache type, typically 'ephemeral' for temporary caching */
  type: 'ephemeral' | string;
  /** Cache Time-To-Live (seconds) */
  ttl?: number;
}

/**
 * JSON Schema Definition
 * Type definition for tool input parameters, following JSON Schema specification
 */
export interface JsonSchema {
  /** Data type: object, string, number, boolean, array, null */
  type?: string;
  /** Object properties definition */
  properties?: Record<string, JsonSchema>;
  /** List of required properties */
  required?: string[];
  /** Schema for array items */
  items?: JsonSchema;
  /** Property description */
  description?: string;
  /** List of enum values */
  enum?: (string | number | boolean)[];
  /** Default value */
  default?: unknown;
  /** Reference to another schema definition */
  $ref?: string;
  /** Collection of schema definitions */
  $defs?: Record<string, JsonSchema>;
  /** Whether additional properties are allowed */
  additionalProperties?: boolean | JsonSchema;
  /** Allow other standard JSON Schema fields */
  [key: string]: unknown;
}

// ============================================================================
// Claude API Types (Claude Request/Response related types)
// ============================================================================

export interface ClaudeRequest {
  model: string;
  messages: Message[];
  system?: SystemPrompt;
  tools?: Tool[];
  stream?: boolean;
  max_tokens?: number;
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tool_choice?: string | { type: string; name?: string; function?: { name: string } };
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  thinking?: ThinkingConfig;
  output_config?: {
    effort?: string;
  };
  /**
   * The OpenAI `response_format`, carried through so JSON mode reaches the upstream
   * `generationConfig`. Declared on the client contract but dropped in the mapping until now,
   * which meant a client that asked for JSON and parsed the answer got prose.
   */
  response_format?: { type?: string };
  metadata?: Metadata;
}

export interface ThinkingConfig {
  type: 'enabled' | string;
  budget_tokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'max' | string;
}

export type SystemPrompt = string | SystemBlock[];

export interface SystemBlock {
  type: string;
  text: string;
}

export interface Message {
  role: string;
  content: string | ContentBlock[];
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ImageBlock
  | DocumentBlock
  | ToolUseBlock
  | ToolResultBlock
  | RedactedThinkingBlock;

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
  /** Cache control configuration */
  cache_control?: CacheControl;
}

export interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

/**
 * Non-image document content, e.g. a PDF. Carries the same inline base64 an
 * {@link ImageBlock} does, because the upstream transport has one
 * representation for both: a Gemini `inlineData` part.
 */
export interface DocumentBlock {
  type: 'document';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
  title?: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  /** Tool input parameters as flexible JSON values */
  input: Record<string, unknown>;
  signature?: string;
  /** Cache control configuration */
  cache_control?: CacheControl;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[]; // Supports text or nested blocks
  is_error?: boolean;
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export interface Tool {
  name: string;
  description?: string;
  /** JSON Schema definition for tool input parameters */
  input_schema?: JsonSchema;
  /** Server tool type, e.g. 'web_search_20250305' */
  type?: string;
}

export interface Metadata {
  user_id?: string;
  source?: string;
  [key: string]: unknown;
}

// ============================================================================
// Gemini API Types (Gemini Request/Response related types)
// ============================================================================

/**
 * Gemini Safety Settings
 * Controls content filtering thresholds
 */
export interface SafetySetting {
  /** Harm category */
  category: string;
  /** Threshold: OFF, BLOCK_LOW_AND_ABOVE, BLOCK_MEDIUM_AND_ABOVE, BLOCK_ONLY_HIGH */
  threshold: string;
}

/**
 * Gemini Generation Config
 * Parameters controlling model generation behavior
 */
export interface GenerationConfig {
  /** Temperature, controls randomness (0-2) */
  temperature?: number;
  /** Top-P sampling parameter */
  topP?: number;
  /** Top-K sampling parameter */
  topK?: number;
  /** Penalizes tokens already present in the generated text. */
  presencePenalty?: number;
  /** Penalizes tokens proportionally to their generated frequency. */
  frequencyPenalty?: number;
  /** Deterministic sampling seed where supported upstream. */
  seed?: number;
  /** Maximum output tokens */
  maxOutputTokens?: number;
  /** List of stop sequences */
  stopSequences?: string[];
  /** Thinking mode configuration */
  thinkingConfig?: ThinkingGeminiConfig;
  /** Response MIME type */
  responseMimeType?: string;
  /** Response modalities */
  responseModalities?: string[];
  /** Image generation configuration */
  imageConfig?: ImageConfig;
}

/**
 * Gemini Thinking Mode Configuration
 */
export interface ThinkingGeminiConfig {
  /** Whether to include thoughts */
  includeThoughts: boolean;
  /** Thinking token budget */
  thinkingBudget?: number;
  /** Thinking level for Claude-native adaptive modes */
  thinkingLevel?: 'low' | 'medium' | 'high' | string;
}

/**
 * Image Generation Configuration
 */
export interface ImageConfig {
  /** Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4 */
  aspectRatio: string;
  /** Image size: 4K */
  imageSize?: string;
}

/**
 * Gemini Tool Declaration
 * Can include function declarations or search tools
 */
export interface GeminiToolDeclaration {
  /** List of function declarations */
  functionDeclarations?: FunctionDeclaration[];
  /** Google Search Tool */
  googleSearch?: Record<string, never>;
  /** Google Search Retrieval Tool */
  googleSearchRetrieval?: Record<string, never>;
}

/**
 * Function Declaration
 * Defines functions callable by the model
 */
export interface FunctionDeclaration {
  /** Function name */
  name: string;
  /** Function description */
  description?: string;
  /** JSON Schema for parameters */
  parameters?: JsonSchema;
}

/**
 * Gemini Function Call
 */
export interface FunctionCall {
  /** Function name */
  name: string;
  /** Function arguments */
  args: Record<string, unknown>;
  /** Call ID */
  id?: string;
}

/**
 * Gemini Function Response
 */
export interface FunctionResponse {
  /** Function name */
  name: string;
  /** Function response result */
  response: Record<string, unknown>;
  /** Call ID */
  id?: string;
}

export interface GeminiToolConfig {
  functionCallingConfig?: {
    mode?: string;
    allowedFunctionNames?: string[];
  };
  includeServerSideToolInvocations?: boolean;
}

export interface GeminiSnakeToolConfig {
  function_calling_config?: {
    mode?: string;
    allowed_function_names?: string[];
  };
  include_server_side_tool_invocations?: boolean;
}

export interface GeminiRequest {
  contents: GeminiContent[];
  /** List of tool declarations */
  tools?: GeminiToolDeclaration[];
  /** Function calling configuration shared by the cached tool declarations. */
  toolConfig?: GeminiToolConfig;
  tool_config?: GeminiSnakeToolConfig;
  /** Safety settings */
  safetySettings?: SafetySetting[];
  /** System instruction */
  systemInstruction?: { parts: { text: string }[] };
  /** Generation config */
  generationConfig?: GenerationConfig;
  /** Server-created explicit context cache resource name. */
  cachedContent?: string;
}

export interface GeminiInternalRequest {
  project?: string;
  requestId: string;
  request: GeminiRequest;
  model: string;
  userAgent: string;
  requestType?: string;
  enabledCreditTypes?: string[];
}

/**
 * CodeAssist `v1internal:countTokens` request envelope.
 *
 * Deliberately narrower than {@link GeminiInternalRequest}: the endpoint accepts only the
 * conversation plus a `models/`-prefixed id, and carries no `project`, `requestId`, `userAgent`
 * or `requestType`.
 */
export interface GeminiCountTokensRequest {
  request: {
    contents: GeminiContent[];
    model: string;
  };
}

export interface GeminiCountTokensResponse {
  totalTokens?: number;
}

export interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

export interface GeminiPart {
  text?: string;
  /** Whether content is 'thought' */
  thought?: boolean;
  /** Thought signature */
  thoughtSignature?: string;
  /** Snake-case thought signature required by strict Gemini internal endpoints */
  thought_signature?: string;
  /** Function call */
  functionCall?: FunctionCall;
  /** Function response */
  functionResponse?: FunctionResponse;
  /** Inline data (images, etc.) */
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

// --- Quota Models ---

export interface QuotaData {
  models: Record<string, ModelQuotaInfo>;
  isForbidden: boolean;
  subscriptionTier?: string;
  model_forwarding_rules?: Record<string, string>;
  is_forbidden?: boolean;
  subscription_tier?: string;
}

export interface ModelQuotaInfo {
  percentage: number;
  resetTime: string;
  display_name?: string;
  supports_images?: boolean;
  supports_thinking?: boolean;
  thinking_budget?: number;
  recommended?: boolean;
  max_tokens?: number;
  max_output_tokens?: number;
  supported_mime_types?: Record<string, boolean>;
}

export interface LoadProjectResponse {
  cloudaicompanionProject?: string;
  currentTier?: Tier;
  paidTier?: Tier;
}

export interface Tier {
  id?: string;
  quotaTier?: string;
  name?: string;
  slug?: string;
}

export interface QuotaApiResponse {
  models: Record<
    string,
    {
      quotaInfo?: { remainingFraction?: number; resetTime?: string };
      displayName?: string;
      supportsImages?: boolean;
      supportsThinking?: boolean;
      thinkingBudget?: number;
      recommended?: boolean;
      maxTokens?: number;
      maxOutputTokens?: number;
      supportedMimeTypes?: Record<string, boolean>;
    }
  >;
  deprecatedModelIds?: Record<string, { newModelId?: string }>;
}

// --- Response Models ---

export interface ClaudeResponse {
  id: string;
  type: string;
  role: string;
  model: string;
  content: ContentBlock[];
  stop_reason: string;
  stop_sequence?: string | null;
  usage: Usage;
  refusal?: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  reasoning_tokens?: number;
  /** Server tool usage stats */
  server_tool_use?: ServerToolUse;
}

/** Server tool usage stats */
export interface ServerToolUse {
  /** Number of web search requests */
  web_search_requests?: number;
}

export interface GeminiResponse {
  candidates?: Candidate[];
  usageMetadata?: UsageMetadata;
  modelVersion?: string;
  responseId?: string;
  promptFeedback?: {
    blockReason?: string;
    blockReasonMessage?: string;
  };
}

export interface Candidate {
  content?: GeminiContent;
  finishReason?: string;
  index?: number;
  groundingMetadata?: GroundingMetadata;
}

export interface UsageMetadata {
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
}

export interface GroundingMetadata {
  /** List of web search queries */
  webSearchQueries?: string[];
  /** Grounding chunks */
  groundingChunks?: GroundingChunk[];
  /** Grounding supports */
  groundingSupports?: GroundingSupport[];
  /** Search entry point */
  searchEntryPoint?: SearchEntryPoint;
}

/** Grounding support info */
export interface GroundingSupport {
  /** Text segment */
  segment?: {
    startIndex?: number;
    endIndex?: number;
  };
  /** Associated grounding chunk indices */
  groundingChunkIndices?: number[];
}

/** Search entry point */
export interface SearchEntryPoint {
  /** Rendered HTML content */
  renderedContent?: string;
}

export interface GroundingChunk {
  web?: {
    uri?: string;
    title?: string;
  };
}
