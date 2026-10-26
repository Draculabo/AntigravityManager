import { createHash } from 'node:crypto';
import { prepareGoogleGenerationContents } from '../server/common/generation-history';
import type { ImageSchedulerConfig } from '@/modules/config/types';
import { v4 as uuidv4 } from 'uuid';
import { isEmpty, isString, sortBy } from 'lodash-es';
import { mapClaudeModelToGemini, normalizeGeminiModelAlias } from './ModelMapping';
import { getMaxOutputTokens, getThinkingBudget } from './ModelSpecs';
import { normalizeObjectJsonSchema } from './JsonSchemaUtils';
import { SchemaConversionBatch, validateSchemaInput } from './schema/SchemaConversion';
import { reportSchemaIssues } from './schema/SchemaPreparation';
import { SignatureStore } from './SignatureStore';
import { isGeminiFlashModel, modelKeepsThinkingWithoutSignature } from './ThoughtSignatureCompat';
import { normalizeSystemPrompt } from './SystemPromptNormalization';
import { recordPromptTransformation } from '../server/common/prompt-transformation-diagnostics';
import { resolveGlobalSystemPrompt } from './GlobalSystemPrompt';
import { extractToolResultImages, parseMarkdownImagesToGeminiParts } from './MarkdownImageParts';
import { hasExplicitAssistantSignature } from './signed-assistant-history';
import { ClaudeToolResultAssociation } from './ClaudeToolResultAssociation';
import { applyGeminiMediaSendWindow } from './MediaSendWindowApply';
import { enhanceGeminiSkillsPrompt } from './SkillPromptEnhancer';
import { toSnakeToolConfig } from './GeminiToolConfigCompat';
import { buildToolConfig, isGoogleSearchToolType } from './ToolChoiceCompat';
import {
  IMAGE_GENERATION_SAFETY_SETTINGS,
  resolveImageGenerationConfig,
  type ImageGenerationConfigInput,
} from './ImageGenerationConfig';
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
  GeminiRequest,
  ContentBlock,
} from './types';
import {
  buildUserAgent,
  FALLBACK_VERSION,
  resolveLocalInstalledVersion,
} from '@/modules/proxy-gateway/server/common/utils/request-user-agent';
import { requiresToolQuotaRoute } from './ToolQuotaRoute';
import { getServerConfig } from '@/server/server-config';

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

export interface ClaudeRequestMapperOptions {
  /** Undefined resolves current configuration for direct mapper/count callers; null pins disabled. */
  globalSystemPrompt?: string | null;
  schemasPrepared?: boolean;
  cacheSchemas?: boolean;
  imageRequest?: ImageGenerationConfigInput;
  signatureTargetFamily?: string | null;
  signatureTargetFamilyModel?: string | null;
  mediaWindow?: ImageSchedulerConfig;
  purpose?: 'generation' | 'count';
}

type RequestType = 'agent' | 'web_search' | 'image_gen';

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
  declarations: FunctionDeclaration[];
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
  source: 'anthropic' | 'openai' = 'anthropic',
  options: ClaudeRequestMapperOptions = {},
): GeminiInternalRequest {
  const { extraSystemMessages, messages } = extractEmbeddedSystemMessages(claudeReq.messages);
  const signatureSessionKey = isString(claudeReq.metadata?.signature_session_key)
    ? claudeReq.metadata.signature_session_key
    : undefined;
  const toolConfig = buildToolConfig(claudeReq.tool_choice, claudeReq.tools ?? []);
  // Check for networking tools (server tool or built-in tool)
  const hasWebSearchTool = detectsNetworkingTool(claudeReq.tools);

  // 1. System Instruction
  const systemInstruction = buildSystemInstruction(
    claudeReq.system,
    extraSystemMessages,
    claudeReq.tools,
    options.globalSystemPrompt,
  );

  // Map model name
  const mappedModel = resolvedModel
    ? resolvedModel.toLowerCase().includes('-image')
      ? resolvedModel
      : normalizeGeminiModelAlias(resolvedModel)
    : mapClaudeModelToGemini(claudeReq.model);

  // Convert Claude tools to Tool array for networking detection
  const normalizedTools: Tool[] | undefined = claudeReq.tools
    ? structuredClone(claudeReq.tools)
    : undefined;

  // Resolve grounding config
  const requestConfig = resolveRequestConfig(
    claudeReq.model,
    mappedModel,
    normalizedTools,
    options.imageRequest,
    resolvedModel !== undefined,
  );
  const signatureTarget = {
    model: requestConfig.finalModel,
    family: options.signatureTargetFamily,
    familyModel: options.signatureTargetFamilyModel,
  };

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
    const sessionSignature = SignatureStore.get({
      ...signatureTarget,
      sessionKey: signatureSessionKey,
    });
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
    options.schemasPrepared === true,
  );
  // Update thinking config based on the final decision
  if (!isThinkingEnabled && generationConfig.thinkingConfig) {
    delete generationConfig.thinkingConfig;
  }

  // 2. Contents (Messages)
  const mappedContents = buildContents(
    messages,
    isThinkingEnabled,
    requestConfig.finalModel,
    signatureSessionKey,
    options.signatureTargetFamily,
    options.signatureTargetFamilyModel,
  );
  const contents =
    options.purpose === 'count'
      ? mappedContents
      : prepareGoogleGenerationContents(mappedContents, requestConfig.finalModel);
  applyGeminiMediaSendWindow(contents, options.mediaWindow);

  // 3. Tools
  const tools = buildTools(claudeReq.tools, hasWebSearchTool, requestConfig.finalModel, options);

  // Build inner request
  const innerRequest: GeminiRequest = {
    contents,
    safetySettings: [...SAFETY_SETTINGS],
  };

  if (systemInstruction) {
    innerRequest.systemInstruction = systemInstruction;
  }

  if (generationConfig && Object.keys(generationConfig).length > 0) {
    innerRequest.generationConfig = generationConfig;
  }

  if (tools) {
    innerRequest.tools = tools;
    const hasFunctionDeclarations = tools.some(
      (tool) => (tool.functionDeclarations?.length ?? 0) > 0,
    );
    if (source === 'anthropic' || hasFunctionDeclarations || claudeReq.tool_choice !== undefined) {
      innerRequest.toolConfig = toolConfig;
      innerRequest.tool_config = toSnakeToolConfig(innerRequest.toolConfig);
    }
  }

  // Inject googleSearch tool if needed (and not already done by buildTools)
  if (requestConfig.injectGoogleSearch && !hasWebSearchTool) {
    injectGoogleSearchTool(innerRequest, requestConfig.finalModel);
  }
  if (innerRequest.tools && innerRequest.toolConfig === undefined) {
    innerRequest.toolConfig = toolConfig;
    innerRequest.tool_config = toSnakeToolConfig(toolConfig);
  }

  // Inject imageConfig if present (for image generation models)
  if (requestConfig.imageConfig) {
    // 1. Remove tools (image generation does not support tools)
    delete innerRequest.tools;
    // 2. Remove systemInstruction (image generation does not support system prompts)
    delete innerRequest.systemInstruction;
    innerRequest.safetySettings = [...IMAGE_GENERATION_SAFETY_SETTINGS];

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
  const requestType =
    params.requestConfig.requestType === 'image_gen'
      ? 'image_gen'
      : requiresToolQuotaRoute({
            tools: params.innerRequest.tools,
            contents: params.innerRequest.contents,
          })
        ? 'agent'
        : undefined;
  const body: GeminiInternalRequest = {
    ...(normalizedProjectId ? { project: normalizedProjectId } : {}),
    request: params.innerRequest,
    model: params.requestConfig.finalModel,
    userAgent: params.userAgent?.trim() || buildUserAgent(discoveryVersion),
    ...(requestType ? { requestType } : {}),
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
  if (innerRequest.tool_config) {
    reordered.tool_config = innerRequest.tool_config;
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
  let initialSystemSection = true;

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== 'system' && message.role !== 'developer') {
      initialSystemSection = false;
      filteredMessages.push(message);
      continue;
    }

    if (initialSystemSection) {
      const systemBlocks: ContentBlock[] = isString(message.content)
        ? [{ type: 'text', text: message.content }]
        : message.content;
      for (const block of systemBlocks) {
        if (block.type === 'text' && block.text !== '') {
          extraSystemMessages.push(block.text);
        }
      }
      recordPromptTransformation({
        kind: 'initial-system-promoted',
        surface: 'messages',
        message: messageIndex,
        part: null,
      });
      continue;
    }
    const text = isString(message.content)
      ? message.content
      : message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
    if (text !== '') {
      recordPromptTransformation({
        kind: 'late-system-reminder',
        surface: 'messages',
        message: messageIndex,
        part: null,
      });
      filteredMessages.push({
        role: 'user',
        content: `<system-reminder>\n${text}\n</system-reminder>`,
      });
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
  imageRequest?: ImageGenerationConfigInput,
  preserveMappedImageModel = false,
): ResolvedRequestConfig {
  // 1. Image Generation Check
  if (isGeminiImageModel(mappedModel)) {
    const { imageConfig } = resolveImageGenerationConfig(originalModel, imageRequest);
    const { parsedBaseModel } = resolveImageGenerationConfig(mappedModel);
    return {
      requestType: 'image_gen',
      injectGoogleSearch: false,
      finalModel: preserveMappedImageModel
        ? parsedBaseModel
        : normalizeGeminiModelAlias(parsedBaseModel),
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

function isGeminiImageModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return (
    normalized.startsWith('gemini-3-pro-image') ||
    normalized.startsWith('gemini-3.1-pro-image') ||
    normalized.startsWith('gemini-3-flash-image') ||
    normalized.startsWith('gemini-3.1-flash-image')
  );
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

/**
 * Detects if networking tools are present
 * Checks tool list for web search related tools
 * Supports Claude Tool and Gemini GeminiToolDeclaration formats
 */
function detectsNetworkingTool(tools?: (Tool | GeminiToolDeclaration)[]): boolean {
  if (!tools) {
    return false;
  }

  for (const tool of tools) {
    const toolType = (tool as { type?: unknown }).type;
    if (isGoogleSearchToolType(toolType)) {
      return true;
    }
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
 * Preserves initial system block order while applying only system-owned normalization.
 */

function buildSystemInstruction(
  system: ClaudeRequest['system'],
  extraSystemMessages: string[],
  tools?: Tool[],
  globalSystemPrompt = resolveGlobalSystemPrompt(getServerConfig()?.global_system_prompt),
): { parts: { text: string }[] } | null {
  const instructions: string[] = [];
  let part = 0;
  const normalize = (text: string) => {
    const index = part++;
    return normalizeSystemPrompt(text, (kind) =>
      recordPromptTransformation({ kind, surface: 'system', message: null, part: index }),
    );
  };

  if (system) {
    if (isString(system)) {
      const cleaned = normalize(system);
      if (cleaned !== '') {
        instructions.push(cleaned);
      }
    } else if (Array.isArray(system)) {
      for (const block of system) {
        if (block.type === 'text') {
          const cleaned = normalize(block.text);
          if (cleaned !== '') {
            instructions.push(cleaned);
          }
        }
      }
    }
  }

  for (const extraText of extraSystemMessages) {
    if (extraText !== '') {
      const cleaned = normalize(extraText);
      if (cleaned !== '') {
        instructions.push(cleaned);
      }
    }
  }

  if (globalSystemPrompt) {
    recordPromptTransformation({
      kind: 'global-system-prepended',
      surface: 'system',
      message: null,
      part: 0,
    });
  }
  const orderedInstructions = [
    ...(globalSystemPrompt
      ? [`<global_system_prompt>\n${globalSystemPrompt}\n</global_system_prompt>`]
      : []),
    ...instructions,
  ];
  if (orderedInstructions.length === 0) {
    return null;
  }

  const text = orderedInstructions.join('\n');
  return { parts: [{ text: enhanceGeminiSkillsPrompt(text, tools) }] };
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
  isThinkingEnabled: boolean,
  mappedModel: string,
  signatureSessionKey?: string,
  signatureTargetFamily?: string | null,
  signatureTargetFamilyModel?: string | null,
): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const toolAssociation = new ClaudeToolResultAssociation();
  let missingSignature: { model: string; toolCallId: string } | null = null;

  for (let i = 0; i < messages.length; i++) {
    // A reasoning block can supply calls in its own message, never a later turn.
    let lastThoughtSignature: string | null = null;
    const msg = messages[i];
    const role = msg.role === 'assistant' ? 'model' : msg.role;
    const parts: GeminiPart[] = [];
    const deferredToolResponses: GeminiPart[] = [];
    const deferredToolMedia: GeminiPart[] = [];
    const contentBlocks = Array.isArray(msg.content)
      ? msg.content
      : msg.content
        ? [{ type: 'text' as const, text: msg.content }]
        : [];
    const preserveAssistantText = hasExplicitAssistantSignature(msg.role, contentBlocks);

    for (const [blockIndex, block] of contentBlocks.entries()) {
      const position = `messages[${i}].content[${blockIndex}]`;
      if (block.type === 'text') {
        if (preserveAssistantText) {
          // Signed history is replayed as supplied, including whitespace and literal Markdown.
          parts.push({ text: block.text });
        } else if (block.text && !isEmpty(block.text.trim())) {
          parts.push(...parseMarkdownImagesToGeminiParts(block.text));
        }
      } else if (block.type === 'thinking') {
        const part: GeminiPart = { text: block.thinking, thought: true };
        if (block.signature) {
          lastThoughtSignature = block.signature;
          part.thoughtSignature = block.signature;
          part.thought_signature = block.signature;
        }
        parts.push(part);
      } else if (
        block.type === 'image' ||
        block.type === 'document' ||
        block.type === 'audio' ||
        block.type === 'video'
      ) {
        // Media blocks differ only in what the client called them; the provider
        // takes inline bytes in one part carrying its own MIME type.
        if (block.source.type === 'base64') {
          parts.push({
            inlineData: { mimeType: block.source.media_type, data: block.source.data },
          });
        } else if (
          (block.type === 'audio' || block.type === 'video') &&
          block.source.type === 'url'
        ) {
          parts.push({
            fileData: { mimeType: block.source.media_type, fileUri: block.source.url },
          });
        }
      } else if (block.type === 'tool_use') {
        const part: GeminiPart = {
          functionCall: { name: block.name, args: block.input, id: block.id },
        };
        toolAssociation.add(block, msg.role, position);
        const signatureTarget = {
          model: mappedModel,
          family: signatureTargetFamily,
          familyModel: signatureTargetFamilyModel,
        };
        const finalSig =
          block.signature ||
          SignatureStore.getForToolCall({
            ...signatureTarget,
            toolCallId: block.id,
            toolName: block.name,
            sessionKey: signatureSessionKey,
          }) ||
          lastThoughtSignature;
        if (finalSig) {
          part.thoughtSignature = finalSig;
          part.thought_signature = finalSig;
        } else if (
          !mappedModel.startsWith('projects/') &&
          (isThinkingEnabled || modelKeepsThinkingWithoutSignature(mappedModel))
        ) {
          missingSignature ??= { model: mappedModel, toolCallId: block.id };
        }
        parts.push(part);
      } else if (block.type === 'tool_result') {
        const funcName = toolAssociation.consume(block, msg.role, position);
        let mergedContent = '';
        const extraParts: GeminiPart[] = [];
        if (isString(block.content)) {
          const extracted = extractToolResultImages(block.content);
          mergedContent = extracted.text;
          extraParts.push(...extracted.media);
        } else if (Array.isArray(block.content)) {
          const textParts: string[] = [];
          for (const content of block.content) {
            if (content.type === 'text') {
              const extracted = extractToolResultImages(content.text);
              textParts.push(extracted.text);
              extraParts.push(...extracted.media);
            } else if (
              (content.type === 'image' ||
                content.type === 'document' ||
                content.type === 'audio' ||
                content.type === 'video') &&
              content.source.type === 'base64'
            ) {
              extraParts.push({
                inlineData: {
                  mimeType: content.source.media_type,
                  data: content.source.data,
                },
              });
            } else if (
              (content.type === 'audio' || content.type === 'video') &&
              content.source.type === 'url'
            ) {
              extraParts.push({
                fileData: {
                  mimeType: content.source.media_type,
                  fileUri: content.source.url,
                },
              });
            }
          }
          mergedContent = textParts.join('\n');
        }
        if (isEmpty(mergedContent.trim()) && extraParts.length === 0) {
          mergedContent = block.is_error
            ? 'Tool execution failed with no output.'
            : 'Command executed successfully.';
        }
        const part: GeminiPart = {
          functionResponse: {
            name: funcName,
            response: { result: mergedContent },
            id: block.tool_use_id,
          },
        };
        // Keep a tool round contiguous: all function responses are emitted
        // first, followed by their media in source order. Interleaving
        // response→image→response→image makes parallel calls ambiguous to
        // providers that associate media with the immediately preceding
        // response.
        deferredToolResponses.push(part);
        deferredToolMedia.push(...extraParts);
      } else if (block.type === 'redacted_thinking') {
        parts.push({ text: `[Redacted Thinking: ${block.data}]`, thought: true });
      }
    }
    parts.push(...deferredToolResponses, ...deferredToolMedia);
    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  if (missingSignature) {
    logger.warn(
      `[ThoughtSig] No matching historical signature; leaving unsigned tool call for model=${missingSignature.model} toolCallId=${missingSignature.toolCallId}`,
    );
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
  options: ClaudeRequestMapperOptions,
): GeminiToolDeclaration[] | null {
  if (!tools || tools.length === 0) {
    return null;
  }

  const batch = new SchemaConversionBatch();
  if (!options.schemasPrepared) {
    for (const tool of tools) {
      if (!isGoogleSearchTool(tool)) {
        validateSchemaInput(tool.input_schema ?? { type: 'object', properties: {} }, batch);
      }
    }
  }
  const hasGoogleSearch = hasWebSearch || tools.some(isGoogleSearchTool);
  const cacheKey = options.cacheSchemas === false ? null : computeToolSchemaCacheKey(tools);
  let functionDeclarations = cacheKey ? lookupToolSchemaCache(cacheKey) : null;
  if (functionDeclarations && !options.schemasPrepared) {
    for (const declaration of functionDeclarations) {
      validateSchemaInput(declaration.parameters, batch);
    }
  }

  if (!functionDeclarations) {
    functionDeclarations = [];
    for (const tool of tools) {
      if (isGoogleSearchTool(tool)) {
        continue;
      }
      if (tool.name) {
        const inputSchema = options.schemasPrepared
          ? structuredClone(tool.input_schema ?? { type: 'object', properties: {} })
          : normalizeObjectJsonSchema(
              tool.input_schema,
              batch,
              'tool',
              functionDeclarations.length,
            );
        functionDeclarations.push({
          name: tool.name,
          description: tool.description,
          parameters: inputSchema,
        });
      }
    }

    if (cacheKey && !batch.degraded) {
      cacheToolSchemas(cacheKey, functionDeclarations);
    }
  }

  functionDeclarations = sortBy(functionDeclarations, (declaration) => declaration.name);
  reportSchemaIssues(batch, 'anthropic');

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
  return isGoogleSearchToolType(tool.type);
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
    entry.hitCount += 1;
    logger.debug(
      `[ToolSchemaCache] HIT hash=${key.slice(0, 16)} hitCount=${entry.hitCount} declarations=${entry.declarations.length}`,
    );
    return structuredClone(entry.declarations);
  } catch {
    toolSchemaCache.delete(key);
    return null;
  }
}

function cacheToolSchemas(key: string, declarations: FunctionDeclaration[]): void {
  try {
    toolSchemaCache.set(key, {
      declarations: structuredClone(declarations),
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
  schemasPrepared: boolean,
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

  // JSON mode is a request-shaping flag, not an OpenAI-only nicety: whoever asks for it parses
  // the answer, so the model has to be told before it answers rather than corrected afterwards.
  const responseFormatType = String(claudeReq.response_format?.type ?? '').toLowerCase();
  if (responseFormatType === 'json_object') {
    config.responseMimeType = 'application/json';
  } else if (responseFormatType === 'json_schema' && claudeReq.response_format?.json_schema) {
    config.responseMimeType = 'application/json';
    config.responseSchema = schemasPrepared
      ? structuredClone(claudeReq.response_format.json_schema.schema)
      : normalizeObjectJsonSchema(
          claudeReq.response_format.json_schema.schema,
          undefined,
          'output',
        );
  }

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
