import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { isEmpty, isPlainObject, isString, sortBy } from 'lodash-es';
import { mapClaudeModelToGemini, normalizeGeminiModelAlias } from './ModelMapping';
import { getMaxOutputTokens, getThinkingBudget } from './ModelSpecs';
import { cleanJsonSchema, normalizeObjectJsonSchema } from './JsonSchemaUtils';
import { SignatureStore } from './SignatureStore';
import { sanitizeSystemInstructionForCache } from './StablePromptPrefix';
import { buildOfficialSystemInstruction } from './OfficialSystemInstruction';
import { parseMarkdownImagesToGeminiParts } from './MarkdownImageParts';
import { enhanceGeminiSkillsPrompt } from './SkillPromptEnhancer';
import { logger } from '@/shared/logging/logger';
import {
  ClaudeRequest,
  Message,
  Tool,
  GeminiInternalRequest,
  GeminiContent,
  GeminiToolDeclaration,
  GeminiPart,
  GenerationConfig,
  ImageConfig,
  FunctionDeclaration,
  SafetySetting,
} from './types';
import {
  buildUserAgent,
  FALLBACK_VERSION,
  resolveLocalInstalledVersion,
} from '@/modules/proxy-gateway/server/common/utils/request-user-agent';

/**
 * Request Configuration
 * Contains request type, model, and image generation configuration
 */
interface ResolvedRequestConfig {
  /** Request type: 'agent', 'web_search', 'image_gen' */
  requestType: RequestType;
  /** Whether to inject Google Search tool */
  injectGoogleSearch: boolean;
  /** Final model name to use */
  finalModel: string;
  /** Image generation config (only for image generation requests) */
  imageConfig: ImageConfig | null;
}

type RequestType = 'agent' | 'web_search' | 'image_gen';

const AGENT_CREDIT_TYPES = ['GOOGLE_ONE_AI'];
const TOOL_SCHEMA_CACHE_LIMIT = 100;
const TOOL_SCHEMA_CACHE_TTL_MS = 30 * 60 * 1000;
const SAFETY_SETTINGS: SafetySetting[] = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
];

interface ToolSchemaCacheEntry {
  declarationsJson: string;
  hitCount: number;
  timestamp: number;
}

const toolSchemaCache = new Map<string, ToolSchemaCacheEntry>();

/**
 * Transforms Claude request into Gemini internal request format
 * @param claudeReq Claude API request
 * @param projectId Gemini Project ID
 * @returns Gemini internal request format
 */
export function transformClaudeRequestIn(
  claudeReq: ClaudeRequest,
  projectId?: string,
  userAgent?: string,
  resolvedModel?: string,
): GeminiInternalRequest {
  const { extraSystemMessages, messages } = extractEmbeddedSystemMessages(claudeReq.messages);
  const signatureSessionKey = isString(claudeReq.metadata?.signature_session_key)
    ? claudeReq.metadata.signature_session_key
    : undefined;
  // Check for networking tools (server tool or built-in tool)
  const hasWebSearchTool = detectsNetworkingTool(claudeReq.tools);

  // Map to store tool_use id -> name mapping
  const toolIdToName = new Map<string, string>();

  // 1. System Instruction
  const systemInstruction = buildSystemInstruction(
    claudeReq.system,
    extraSystemMessages,
    claudeReq.tools,
  );

  // Map model name
  const mappedModel = resolvedModel
    ? normalizeGeminiModelAlias(resolvedModel)
    : mapClaudeModelToGemini(claudeReq.model);

  // Convert Claude tools to Tool array for networking detection
  const normalizedTools: Tool[] | undefined = claudeReq.tools
    ? (JSON.parse(JSON.stringify(claudeReq.tools)) as Tool[])
    : undefined;

  // Resolve grounding config
  const requestConfig = resolveRequestConfig(claudeReq.model, mappedModel, normalizedTools);

  const allowDummyThought = requestConfig.finalModel.startsWith('gemini-');

  // 4. Generation Config & Thinking
  const thinkingType = (claudeReq.thinking?.type ?? '').toLowerCase();
  const autoThinkingEnabled =
    !claudeReq.thinking && shouldEnableThinkingByDefault(requestConfig.finalModel, claudeReq.model);
  let isThinkingEnabled =
    thinkingType === 'enabled' || thinkingType === 'adaptive' || autoThinkingEnabled;

  if (isThinkingEnabled && !targetModelSupportsThinking(requestConfig.finalModel)) {
    logger.warn(
      `[Thinking-Mode] Target model ${requestConfig.finalModel} does not support thinking. Disabling thinking mode.`,
    );
    isThinkingEnabled = false;
  }

  if (isThinkingEnabled) {
    const sessionSignature = SignatureStore.get(signatureSessionKey);
    const hasFunctionCalls = messages.some((m) => {
      if (Array.isArray(m.content)) {
        return m.content.some((b) => b.type === 'tool_use');
      }
      return false;
    });

    if (hasFunctionCalls && !hasValidSignatureForFunctionCalls(messages, sessionSignature)) {
      if (!modelKeepsThinkingWithoutSignature(requestConfig.finalModel)) {
        isThinkingEnabled = false;
      }
    }
  }

  const generationConfig = buildGenerationConfig(
    claudeReq,
    hasWebSearchTool,
    requestConfig.finalModel,
    isThinkingEnabled,
  );
  // Update thinking config based on the final decision
  if (!isThinkingEnabled && generationConfig.thinkingConfig) {
    delete generationConfig.thinkingConfig;
  }

  // 2. Contents (Messages)
  const contents = buildContents(
    messages,
    toolIdToName,
    isThinkingEnabled,
    allowDummyThought,
    requestConfig.finalModel,
    signatureSessionKey,
  );

  // 3. Tools
  const tools = buildTools(claudeReq.tools, hasWebSearchTool, requestConfig.finalModel);

  // Build inner request
  const innerRequest: {
    contents: GeminiContent[];
    safetySettings: SafetySetting[];
    systemInstruction?: { parts: { text: string }[] };
    generationConfig?: GenerationConfig;
    tools?: GeminiToolDeclaration[];
    toolConfig?: {
      functionCallingConfig: {
        mode: string;
        allowedFunctionNames?: string[];
      };
    };
  } = {
    contents,
    safetySettings: [...SAFETY_SETTINGS],
  };

  deepCleanUndefined(innerRequest);

  if (systemInstruction) {
    innerRequest.systemInstruction = systemInstruction;
  }

  if (generationConfig && Object.keys(generationConfig).length > 0) {
    innerRequest.generationConfig = generationConfig;
  }

  if (tools) {
    innerRequest.tools = tools;
    innerRequest.toolConfig = buildToolConfig(claudeReq.tool_choice);
  }

  // Inject googleSearch tool if needed (and not already done by buildTools)
  if (requestConfig.injectGoogleSearch && !hasWebSearchTool) {
    injectGoogleSearchTool(innerRequest, requestConfig.finalModel);
  }

  // Inject imageConfig if present (for image generation models)
  if (requestConfig.imageConfig) {
    // 1. Remove tools (image generation does not support tools)
    delete innerRequest.tools;
    // 2. Remove systemInstruction (image generation does not support system prompts)
    delete innerRequest.systemInstruction;

    // 3. Clean generationConfig
    const imageGenerationConfig = innerRequest.generationConfig || {};
    delete imageGenerationConfig.thinkingConfig;
    delete imageGenerationConfig.responseMimeType;
    delete imageGenerationConfig.responseModalities;
    imageGenerationConfig.imageConfig = requestConfig.imageConfig;
    innerRequest.generationConfig = imageGenerationConfig;
  }

  const reorderedInnerRequest = reorderInnerRequestForCache(
    innerRequest as GeminiInternalRequest['request'],
  );
  const body = buildInternalRequestBody({
    requestConfig,
    innerRequest: reorderedInnerRequest,
    projectId,
    userAgent,
  });

  return body;
}

/**
 * Builds the `v1internal` envelope.
 *
 * Deliberately carries no session identifier. An Anthropic client's advisory
 * `metadata.user_id` used to be forwarded as `sessionId`, which the provider
 * answers with `Invalid JSON payload received. Unknown name "sessionId":
 * Cannot find field.`, failing the whole request. There is no accepted
 * destination for it on this transport, and the field is advisory in
 * Anthropic's own API, so it is dropped here rather than costing the caller
 * the request.
 */
function buildInternalRequestBody(params: {
  requestConfig: ResolvedRequestConfig;
  innerRequest: GeminiInternalRequest['request'];
  projectId?: string;
  userAgent?: string;
}): GeminiInternalRequest {
  const normalizedProjectId = params.projectId?.trim();
  const discoveryVersion = resolveLocalInstalledVersion() ?? FALLBACK_VERSION;
  const isAgentRequest = params.requestConfig.requestType !== 'image_gen';
  const body: GeminiInternalRequest = {
    ...(normalizedProjectId ? { project: normalizedProjectId } : {}),
    request: params.innerRequest,
    model: params.requestConfig.finalModel,
    userAgent: params.userAgent?.trim() || buildUserAgent(discoveryVersion),
    requestType: isAgentRequest ? 'agent' : 'image_gen',
    ...(isAgentRequest ? { enabledCreditTypes: [...AGENT_CREDIT_TYPES] } : {}),
    requestId: createOfficialRequestId(),
  };

  return body;
}

/**
 * Keep the large, repeatable request prefix before dynamic conversation contents.
 * Property order is preserved by JSON.stringify in the request transport.
 */
function reorderInnerRequestForCache(
  innerRequest: GeminiInternalRequest['request'],
): GeminiInternalRequest['request'] {
  const reordered: Partial<GeminiInternalRequest['request']> = {};

  if (innerRequest.systemInstruction) {
    reordered.systemInstruction = innerRequest.systemInstruction;
  }
  if (innerRequest.tools) {
    reordered.tools = innerRequest.tools;
  }
  if (innerRequest.toolConfig) {
    reordered.toolConfig = innerRequest.toolConfig;
  }
  if (innerRequest.generationConfig) {
    reordered.generationConfig = innerRequest.generationConfig;
  }
  if (innerRequest.safetySettings) {
    reordered.safetySettings = innerRequest.safetySettings;
  }

  reordered.contents = innerRequest.contents ?? [];

  const reorderedRecord = reordered as Record<string, unknown>;
  for (const [key, value] of Object.entries(innerRequest)) {
    if (!(key in reorderedRecord)) {
      reorderedRecord[key] = value;
    }
  }

  return reordered as GeminiInternalRequest['request'];
}

function extractEmbeddedSystemMessages(messages: Message[]): {
  extraSystemMessages: string[];
  messages: Message[];
} {
  const extraSystemMessages: string[] = [];
  const filteredMessages: Message[] = [];

  for (const message of messages) {
    if (message.role !== 'system') {
      filteredMessages.push(message);
      continue;
    }

    if (isString(message.content)) {
      extraSystemMessages.push(message.content);
      continue;
    }

    for (const block of message.content) {
      if (block.type === 'text') {
        extraSystemMessages.push(block.text);
      }
    }
  }

  return { extraSystemMessages, messages: filteredMessages };
}

function createOfficialRequestId(): string {
  const timestampMs = Date.now();
  const randomHex = uuidv4().replace(/-/g, '').slice(0, 8);
  return `agent/${timestampMs}/${randomHex}`;
}

/**
 * Resolves request configuration
 * Determines request type and whether to inject search tools based on model name and tools
 */
function resolveRequestConfig(
  originalModel: string,
  mappedModel: string,
  tools?: Tool[],
): ResolvedRequestConfig {
  // 1. Image Generation Check
  if (isGeminiImageModel(mappedModel)) {
    const { imageConfig, parsedBaseModel } = parseImageConfig(originalModel);
    return {
      requestType: 'image_gen',
      injectGoogleSearch: false,
      finalModel: parsedBaseModel,
      imageConfig,
    };
  }

  const hasNetworkingTool = detectsNetworkingTool(tools);

  // Strip -online suffix
  const isOnlineSuffix = originalModel.endsWith('-online');

  const enableNetworking = isOnlineSuffix || hasNetworkingTool;

  let finalModel = mappedModel.replace(/-online$/, '');
  finalModel = normalizeGeminiModelAlias(finalModel);

  if (enableNetworking && !supportsWebSearchModel(finalModel)) {
    finalModel = 'gemini-3-flash';
  }

  return {
    requestType: enableNetworking ? 'web_search' : 'agent',
    injectGoogleSearch: enableNetworking,
    finalModel,
    imageConfig: null,
  };
}

function supportsWebSearchModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return (
    normalized === 'gemini-2.5-flash' ||
    normalized === 'gemini-1.5-pro' ||
    normalized.startsWith('gemini-1.5-pro-') ||
    normalized.startsWith('gemini-2.5-flash-') ||
    normalized.startsWith('gemini-2.0-flash') ||
    normalized.startsWith('gemini-3-') ||
    normalized.startsWith('gemini-3.') ||
    normalized.startsWith('gemini-3.5-') ||
    normalized.startsWith('gemini-pro-') ||
    normalized.startsWith('agent') ||
    normalized.includes('claude-3-5-sonnet') ||
    normalized.includes('claude-3-opus') ||
    normalized.includes('claude-sonnet') ||
    normalized.includes('claude-opus') ||
    normalized.includes('claude-4')
  );
}

/**
 * Parses image generation configuration
 * Extracts aspect ratio and resolution settings from model name
 */
function parseImageConfig(modelName: string): {
  imageConfig: ImageConfig;
  parsedBaseModel: string;
} {
  const normalizedModel = modelName.toLowerCase();
  let aspectRatio = '1:1';
  if (modelName.includes('-16x9')) aspectRatio = '16:9';
  else if (modelName.includes('-9x16')) aspectRatio = '9:16';
  else if (modelName.includes('-4x3')) aspectRatio = '4:3';
  else if (modelName.includes('-3x4')) aspectRatio = '3:4';
  else if (modelName.includes('-1x1')) aspectRatio = '1:1';

  const isHd = modelName.includes('-4k') || modelName.includes('-hd');

  const config: ImageConfig = { aspectRatio };
  if (isHd) {
    config.imageSize = '4K';
  }

  const parsedBaseModel =
    normalizedModel.startsWith('gemini-3.1-flash-image') ||
    normalizedModel.startsWith('gemini-3-flash-image')
      ? 'gemini-3.1-flash-image'
      : normalizedModel.startsWith('gemini-3.1-pro-image')
        ? 'gemini-3.1-pro-image'
        : 'gemini-3-pro-image';

  return { imageConfig: config, parsedBaseModel };
}

function isGeminiImageModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return (
    normalized.startsWith('gemini-3-pro-image') ||
    normalized.startsWith('gemini-3.1-pro-image') ||
    normalized.startsWith('gemini-3-flash-image') ||
    normalized.startsWith('gemini-3.1-flash-image')
  );
}

function isGeminiFlashModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return normalized.includes('gemini') && normalized.includes('flash');
}

/**
 * Keep forced-thinking targets enabled when tool history has no reusable signature.
 * These models accept the provider sentinel injected into unsigned function calls.
 */
function modelKeepsThinkingWithoutSignature(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return isGeminiFlashModel(normalized) || normalized.includes('gemini-pro-agent');
}

function isGeminiAgentThinkingModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return (
    normalized.includes('gemini') &&
    !normalized.includes('claude') &&
    (normalized.includes('gemini-pro') ||
      normalized.includes('-pro-agent') ||
      normalized.includes('-flash-agent'))
  );
}

function targetModelSupportsThinking(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  const isTieredGeminiPro = /^gemini-3(?:\.1)?-pro-(high|low)$/.test(normalized);
  const isUntieredGeminiPro =
    (normalized.includes('gemini-3-pro') || normalized.includes('gemini-3.1-pro')) &&
    !isTieredGeminiPro &&
    !isGeminiImageModel(normalized);

  return (
    normalized.includes('-thinking') ||
    isClaudeModel(normalized) ||
    normalized.includes('gemini-2.0-pro') ||
    isUntieredGeminiPro ||
    isGeminiAgentThinkingModel(normalized) ||
    isGeminiFlashModel(normalized)
  );
}

function shouldEnableThinkingByDefault(mappedModel: string, originalModel: string): boolean {
  const mappedLower = mappedModel.toLowerCase();
  const originalLower = originalModel.toLowerCase();
  return (
    originalLower.includes('claude-opus-4-5') ||
    originalLower.includes('claude-opus-4-6') ||
    mappedLower.includes('-thinking') ||
    mappedLower.includes('gemini-3.1-pro') ||
    isGeminiAgentThinkingModel(mappedLower) ||
    mappedLower.includes('gemini-3-flash') ||
    mappedLower.includes('gemini-3.1-flash')
  );
}

function isClaudeModel(modelName: string): boolean {
  return modelName.toLowerCase().includes('claude');
}

function resolveAdaptiveThinkingLevel(claudeReq: ClaudeRequest): 'low' | 'medium' | 'high' {
  const effort = String(claudeReq.thinking?.effort ?? '').toLowerCase();
  if (effort === 'low') {
    return 'low';
  }
  if (effort === 'medium') {
    return 'medium';
  }
  return 'high';
}

function toToolSchema(schema: unknown): Record<string, unknown> {
  return normalizeObjectJsonSchema(schema);
}

/**
 * Detects if networking tools are present
 * Checks tool list for web search related tools
 * Supports Claude Tool and Gemini GeminiToolDeclaration formats
 */
function detectsNetworkingTool(tools?: (Tool | GeminiToolDeclaration)[]): boolean {
  if (!tools) {
    return false;
  }
  const keywords = [
    'web_search',
    'google_search',
    'web_search_20250305',
    'google_search_retrieval',
    'builtin_web_search',
  ];

  for (const tool of tools) {
    // Claude Tool format
    const toolName = (tool as { name?: unknown }).name;
    if (isString(toolName) && keywords.includes(toolName)) {
      return true;
    }
    const toolType = (tool as { type?: unknown }).type;
    if (isString(toolType) && keywords.includes(toolType)) {
      return true;
    }

    // OpenAI nested format (runtime check)
    const openaiTool = tool as { function?: { name?: string } };
    if (isString(openaiTool.function?.name) && keywords.includes(openaiTool.function.name)) {
      return true;
    }

    // Gemini GeminiToolDeclaration format
    if ('functionDeclarations' in tool && tool.functionDeclarations) {
      for (const decl of tool.functionDeclarations) {
        if (decl.name && keywords.includes(decl.name)) {
          return true;
        }
      }
    }

    // Gemini search tools
    if ('googleSearch' in tool && tool.googleSearch) {
      return true;
    }
    if ('googleSearchRetrieval' in tool && tool.googleSearchRetrieval) {
      return true;
    }
  }
  return false;
}

function injectGoogleSearchTool(body: { tools?: GeminiToolDeclaration[] }, mappedModel?: string) {
  if (!body.tools) {
    body.tools = [];
  }
  const toolsArr = body.tools;

  const hasFunctions = toolsArr.some((t) => t.functionDeclarations);
  if (hasFunctions) {
    logger.info(
      `[Claude-Request] Skipping googleSearch injection for ${mappedModel ?? 'unknown-model'} because functionDeclarations are present (v1internal incompatible)`,
    );
    return;
  }

  // Remove existing to avoid duplicates
  body.tools = toolsArr.filter((t) => !t.googleSearch && !t.googleSearchRetrieval);
  body.tools.push({ googleSearch: {} });
}

/**
 * Builds system instruction
 * Converts Claude system prompts to Gemini format with a default assistant identity directive.
 */
function buildSystemInstruction(
  system: ClaudeRequest['system'],
  extraSystemMessages: string[],
  tools?: Tool[],
): { parts: { text: string }[] } | null {
  const assistantIdentityDirective =
    'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.\n' +
    'You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.\n' +
    '**Absolute paths only**\n' +
    '**Proactiveness**';
  const instructions: string[] = [];

  if (system) {
    if (isString(system)) {
      instructions.push(sanitizeSystemInstructionForCache(system));
    } else if (Array.isArray(system)) {
      for (const block of system) {
        if (block.type === 'text') {
          instructions.push(sanitizeSystemInstructionForCache(block.text));
        }
      }
    }
  }

  for (const extraText of extraSystemMessages) {
    if (!isEmpty(extraText.trim())) {
      instructions.push(sanitizeSystemInstructionForCache(extraText));
    }
  }

  const text = buildOfficialSystemInstruction(instructions, assistantIdentityDirective);
  return text ? { parts: [{ text: enhanceGeminiSkillsPrompt(text, tools) }] } : null;
}

/**
 * Minimum length for a valid thought_signature
 */
const MIN_SIGNATURE_LENGTH = 10;

/**
 * Check if we have any valid signature available for function calls
 * @param messages  Messages from ClaudeRequest
 * @param sessionSignature  Signature from session-scoped storage
 * @returns  True if any valid signature is available for function calls
 */
function hasValidSignatureForFunctionCalls(
  messages: Message[],
  sessionSignature: string | null | undefined,
): boolean {
  // 1. Check session-scoped store
  if (sessionSignature && sessionSignature.length >= MIN_SIGNATURE_LENGTH) {
    return true;
  }

  // 2. Check if any message has a thinking block with valid signature
  // Traverse in reverse to find recent signatures
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            block.type === 'thinking' &&
            block.signature &&
            block.signature.length >= MIN_SIGNATURE_LENGTH
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * Builds message contents
 * Converts Claude message list to Gemini content format
 */
function buildContents(
  messages: Message[],
  toolIdToName: Map<string, string>,
  isThinkingEnabled: boolean,
  allowDummyThought: boolean,
  mappedModel: string,
  signatureSessionKey?: string,
): GeminiContent[] {
  const contents: GeminiContent[] = [];
  let lastThoughtSignature: string | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role === 'assistant' ? 'model' : msg.role;
    const parts: GeminiPart[] = [];
    const contentBlocks = Array.isArray(msg.content)
      ? msg.content
      : msg.content
        ? [{ type: 'text' as const, text: msg.content }]
        : [];

    for (const block of contentBlocks) {
      if (block.type === 'text') {
        if (block.text && block.text !== '(no content)' && !isEmpty(block.text.trim())) {
          parts.push(...parseMarkdownImagesToGeminiParts(block.text.trim()));
        }
      } else if (block.type === 'thinking') {
        const part: GeminiPart = { text: block.thinking, thought: true };
        cleanJsonSchema(part);
        if (block.signature) {
          lastThoughtSignature = block.signature;
          part.thoughtSignature = block.signature;
          part.thought_signature = block.signature;
        }
        parts.push(part);
      } else if (block.type === 'image') {
        if (block.source.type === 'base64')
          parts.push({
            inlineData: { mimeType: block.source.media_type, data: block.source.data },
          });
      } else if (block.type === 'tool_use') {
        const part: GeminiPart = {
          functionCall: { name: block.name, args: block.input, id: block.id },
        };
        cleanJsonSchema(part);
        toolIdToName.set(block.id, block.name);
        const finalSig =
          block.signature ||
          lastThoughtSignature ||
          SignatureStore.getAt(signatureSessionKey, i) ||
          SignatureStore.get(signatureSessionKey);
        if (finalSig) {
          part.thoughtSignature = finalSig;
          part.thought_signature = finalSig;
        } else if (isThinkingEnabled && modelKeepsThinkingWithoutSignature(mappedModel)) {
          part.thoughtSignature = 'skip_thought_signature_validator';
          part.thought_signature = 'skip_thought_signature_validator';
        }
        parts.push(part);
      } else if (block.type === 'tool_result') {
        const funcName = toolIdToName.get(block.tool_use_id) || block.tool_use_id;
        let mergedContent = '';
        if (isString(block.content)) mergedContent = block.content;
        else if (Array.isArray(block.content))
          mergedContent = block.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n');
        if (isEmpty(mergedContent.trim()))
          mergedContent = block.is_error
            ? 'Tool execution failed with no output.'
            : 'Command executed successfully.';
        const part: any = {
          functionResponse: {
            name: funcName,
            response: { result: mergedContent },
            id: block.tool_use_id,
          },
        };
        if (lastThoughtSignature) {
          part.thoughtSignature = lastThoughtSignature;
          part.thought_signature = lastThoughtSignature;
        }
        parts.push(part);
      } else if (block.type === 'redacted_thinking') {
        parts.push({ text: `[Redacted Thinking: ${block.data}]`, thought: true });
      }
    }
    if (allowDummyThought && role === 'model' && isThinkingEnabled && i === messages.length - 1) {
      const hasThought = parts.some((p) => p.thought === true);
      if (!hasThought) parts.unshift({ text: 'Thinking...', thought: true });
    }
    if (parts.length > 0) contents.push({ role, parts });
  }
  return contents;
}

/**
 * build tools
 * convert claude tools to gemini function declarations
 */
function buildTools(
  tools: Tool[] | undefined,
  hasWebSearch: boolean,
  mappedModel: string,
): GeminiToolDeclaration[] | null {
  if (!tools || tools.length === 0) {
    return null;
  }

  const hasGoogleSearch = hasWebSearch || tools.some(isGoogleSearchTool);
  const cacheKey = computeToolSchemaCacheKey(tools);
  let functionDeclarations = cacheKey ? lookupToolSchemaCache(cacheKey) : null;

  if (!functionDeclarations) {
    functionDeclarations = [];
    for (const tool of tools) {
      if (isGoogleSearchTool(tool)) {
        continue;
      }
      if (tool.name) {
        const inputSchema = toToolSchema(tool.input_schema);
        functionDeclarations.push({
          name: tool.name,
          description: tool.description,
          parameters: inputSchema,
        });
      }
    }

    if (cacheKey) {
      cacheToolSchemas(cacheKey, functionDeclarations);
    }
  }

  functionDeclarations = sortBy(functionDeclarations, (declaration) => declaration.name);

  const toolList: GeminiToolDeclaration[] = [];
  if (functionDeclarations.length > 0) {
    toolList.push({ functionDeclarations });
    if (hasGoogleSearch) {
      logger.info(
        `[Claude-Request] Skipping googleSearch injection for ${mappedModel} because functionDeclarations are present (v1internal incompatible)`,
      );
    }
  } else if (hasGoogleSearch) {
    toolList.push({ googleSearch: {} });
  }

  if (toolList.length > 0) {
    return toolList;
  }
  return null;
}

function isGoogleSearchTool(tool: Tool): boolean {
  return (
    tool.name === 'web_search' ||
    tool.name === 'google_search' ||
    tool.name === 'builtin_web_search' ||
    tool.type === 'web_search_20250305' ||
    tool.type === 'builtin_web_search'
  );
}

function computeToolSchemaCacheKey(tools: Tool[]): string | null {
  try {
    const rawJson = JSON.stringify(tools);
    if (!rawJson) {
      return null;
    }
    return createHash('sha256').update(rawJson).digest('hex');
  } catch {
    return null;
  }
}

function lookupToolSchemaCache(key: string): FunctionDeclaration[] | null {
  const entry = toolSchemaCache.get(key);
  if (!entry) {
    return null;
  }

  if (Date.now() - entry.timestamp > TOOL_SCHEMA_CACHE_TTL_MS) {
    toolSchemaCache.delete(key);
    return null;
  }

  try {
    const declarations = JSON.parse(entry.declarationsJson) as FunctionDeclaration[];
    if (!Array.isArray(declarations)) {
      toolSchemaCache.delete(key);
      return null;
    }
    entry.hitCount += 1;
    logger.debug(
      `[ToolSchemaCache] HIT hash=${key.slice(0, 16)} hitCount=${entry.hitCount} declarations=${declarations.length}`,
    );
    return declarations;
  } catch {
    toolSchemaCache.delete(key);
    return null;
  }
}

function cacheToolSchemas(key: string, declarations: FunctionDeclaration[]): void {
  try {
    toolSchemaCache.set(key, {
      declarationsJson: JSON.stringify(declarations),
      hitCount: 0,
      timestamp: Date.now(),
    });
  } catch {
    return;
  }

  evictToolSchemaCache();
  logger.debug(
    `[ToolSchemaCache] INSERT hash=${key.slice(0, 16)} declarations=${declarations.length}`,
  );
}

function evictToolSchemaCache(): void {
  const oldestAllowed = Date.now() - TOOL_SCHEMA_CACHE_TTL_MS;
  for (const [key, entry] of toolSchemaCache) {
    if (entry.timestamp < oldestAllowed) {
      toolSchemaCache.delete(key);
    }
  }

  while (toolSchemaCache.size > TOOL_SCHEMA_CACHE_LIMIT) {
    const oldestKey = toolSchemaCache.keys().next().value;
    if (!oldestKey) {
      return;
    }
    toolSchemaCache.delete(oldestKey);
  }
}

/**
 * build generation config
 * convert claude request parameters to gemini generation config
 */
function buildGenerationConfig(
  claudeReq: ClaudeRequest,
  hasWebSearch: boolean,
  mappedModel: string,
  isThinkingEnabled: boolean,
): GenerationConfig {
  const source = String(claudeReq.metadata?.source || '').toLowerCase();
  const isOpenAIPath = source === 'openai';
  const config: GenerationConfig = {};
  const thinkingType = String(claudeReq.thinking?.type ?? '').toLowerCase();

  const buildThinkingConfig = (): GenerationConfig['thinkingConfig'] => {
    const thinkingConfig: GenerationConfig['thinkingConfig'] = { includeThoughts: true };
    if (thinkingType === 'adaptive') {
      if (isClaudeModel(mappedModel)) {
        thinkingConfig.thinkingLevel = resolveAdaptiveThinkingLevel(claudeReq);
      } else {
        thinkingConfig.thinkingBudget = 24576;
      }
    } else if (claudeReq.thinking?.budget_tokens) {
      let budget = claudeReq.thinking.budget_tokens;
      const isFlash = hasWebSearch || isGeminiFlashModel(mappedModel);
      if (isFlash) {
        budget = Math.min(budget, 24576);
      }
      thinkingConfig.thinkingBudget = budget;
    } else {
      thinkingConfig.thinkingBudget = getThinkingBudget(mappedModel);
    }
    return thinkingConfig;
  };

  if (isOpenAIPath) {
    config.temperature = claudeReq.temperature ?? 1.0;
    config.topP = claudeReq.top_p ?? 0.95;
    config.presencePenalty = claudeReq.presence_penalty;
    config.frequencyPenalty = claudeReq.frequency_penalty;
    config.seed = claudeReq.seed;
    if (claudeReq.max_tokens !== undefined) {
      config.maxOutputTokens = claudeReq.max_tokens;
    } else {
      config.maxOutputTokens = getMaxOutputTokens(mappedModel);
    }
    if (claudeReq.stop_sequences && claudeReq.stop_sequences.length > 0) {
      config.stopSequences = claudeReq.stop_sequences;
    }
    if (isThinkingEnabled) {
      config.thinkingConfig = buildThinkingConfig();
    }
    return config;
  }

  if (isThinkingEnabled) {
    config.thinkingConfig = buildThinkingConfig();
  }
  if (claudeReq.temperature !== undefined) {
    config.temperature = claudeReq.temperature;
  }
  if (claudeReq.top_p !== undefined) {
    config.topP = claudeReq.top_p;
  }
  if (claudeReq.top_k !== undefined) {
    config.topK = claudeReq.top_k;
  }
  if (claudeReq.max_tokens !== undefined) {
    config.maxOutputTokens = claudeReq.max_tokens;
  }
  config.stopSequences = ['<|user|>', '<|endoftext|>', '<|end_of_turn|>', '[DONE]', '\n\nHuman:'];
  return config;
}

function buildToolConfig(toolChoice: ClaudeRequest['tool_choice']): {
  functionCallingConfig: {
    mode: string;
    allowedFunctionNames?: string[];
  };
} {
  let mode = 'VALIDATED';
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'none') {
      mode = 'NONE';
    } else if (toolChoice === 'auto') {
      mode = 'AUTO';
    } else {
      mode = 'ANY';
    }
  } else if (toolChoice) {
    mode = 'ANY';
  }

  return {
    functionCallingConfig: {
      mode,
    },
  };
}

/**
 * deep clean undefined values
 * recursively delete all properties with undefined values
 * @param obj
 */
function deepCleanUndefined(obj: unknown): void {
  if (Array.isArray(obj)) {
    obj.forEach(deepCleanUndefined);
  } else if (isPlainObject(obj)) {
    const record = obj as Record<string, unknown>;
    Object.keys(record).forEach((key) => {
      if (record[key] === undefined) delete record[key];
      else deepCleanUndefined(record[key]);
    });
  }
}
