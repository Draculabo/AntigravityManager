import { v4 as uuidv4 } from 'uuid';
import { isEmpty, isPlainObject, isString } from 'lodash-es';
import { mapClaudeModelToGemini, normalizeGeminiModelAlias } from './ModelMapping';
import { getMaxOutputTokens, getThinkingBudget } from './ModelSpecs';
import { cleanJsonSchema, normalizeObjectJsonSchema } from './JsonSchemaUtils';
import { SignatureStore } from './SignatureStore';
import { logger } from '../../utils/logger';
import {
  ClaudeRequest,
  Message,
  Tool,
  GeminiInternalRequest,
  GeminiContent,
  GeminiToolDeclaration,
  GenerationConfig,
  ImageConfig,
  FunctionDeclaration,
  SafetySetting,
} from './types';
import {
  buildUserAgent,
  FALLBACK_VERSION,
  resolveLocalInstalledVersion,
} from '@/server/modules/proxy/request-user-agent';

/**
 * Request Configuration
 * Contains request type, model, and image generation configuration
 */
interface RequestConfig {
  /** Request type: 'agent', 'web_search', 'image_gen' */
  requestType: string;
  /** Whether to inject Google Search tool */
  injectGoogleSearch: boolean;
  /** Final model name to use */
  finalModel: string;
  /** Image generation config (only for image generation requests) */
  imageConfig: ImageConfig | null;
}

// --- Main Logic ---

// --- Main Logic ---

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
): GeminiInternalRequest {
  // Check for networking tools (server tool or built-in tool)
  const hasWebSearchTool = detectsNetworkingTool(claudeReq.tools);

  // Map to store tool_use id -> name mapping
  const toolIdToName = new Map<string, string>();

  // 1. System Instruction
  const systemInstruction = buildSystemInstruction(claudeReq.system);

  // Map model name
  const mappedModel = hasWebSearchTool ? 'gemini-3-flash' : mapClaudeModelToGemini(claudeReq.model);

  // Convert Claude tools to Tool array for networking detection
  const toolsVal: Tool[] | undefined = claudeReq.tools
    ? (JSON.parse(JSON.stringify(claudeReq.tools)) as Tool[])
    : undefined;

  // Resolve grounding config
  const config = resolveRequestConfig(claudeReq.model, mappedModel, toolsVal);

  const allowDummyThought = config.finalModel.startsWith('gemini-');

  // 4. Generation Config & Thinking
  const thinkingType = (claudeReq.thinking?.type ?? '').toLowerCase();
  const autoThinkingEnabled =
    !claudeReq.thinking && shouldEnableThinkingByDefault(config.finalModel, claudeReq.model);
  let isThinkingEnabled =
    thinkingType === 'enabled' || thinkingType === 'adaptive' || autoThinkingEnabled;

  if (isThinkingEnabled) {
    const globalSig = SignatureStore.get();
    const hasFunctionCalls = claudeReq.messages.some((m) => {
      if (Array.isArray(m.content)) {
        return m.content.some((b) => b.type === 'tool_use');
      }
      return false;
    });

    if (hasFunctionCalls && !hasValidSignatureForFunctionCalls(claudeReq.messages, globalSig)) {
      if (!isGeminiFlashModel(config.finalModel)) {
        isThinkingEnabled = false;
      }
    }
  }

  const generationConfig = buildGenerationConfig(
    claudeReq,
    hasWebSearchTool,
    config.finalModel,
    isThinkingEnabled,
  );
  // Update thinking config based on the final decision
  if (!isThinkingEnabled && generationConfig.thinkingConfig) {
    delete generationConfig.thinkingConfig;
  }

  // 2. Contents (Messages)
  const contents = buildContents(
    claudeReq.messages,
    toolIdToName,
    isThinkingEnabled,
    allowDummyThought,
    config.finalModel,
  );

  // 3. Tools
  const tools = buildTools(claudeReq.tools, hasWebSearchTool, config.finalModel);

  // 5. Safety Settings
  const safetySettings = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
  ];

  // Build inner request
  const innerRequest: {
    contents: GeminiContent[];
    safetySettings: SafetySetting[];
    systemInstruction?: { parts: { text: string }[] };
    generationConfig?: GenerationConfig;
    tools?: GeminiToolDeclaration[];
    toolConfig?: { functionCallingConfig: { mode: string } };
  } = {
    contents,
    safetySettings,
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
    innerRequest.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } };
  }

  // Inject googleSearch tool if needed (and not already done by buildTools)
  if (config.injectGoogleSearch && !hasWebSearchTool) {
    injectGoogleSearchTool(innerRequest, config.finalModel);
  }

  // Inject imageConfig if present (for image generation models)
  if (config.imageConfig) {
    // 1. Remove tools (image generation does not support tools)
    delete innerRequest.tools;
    // 2. Remove systemInstruction (image generation does not support system prompts)
    delete innerRequest.systemInstruction;

    // 3. Clean generationConfig
    const genConfig = innerRequest.generationConfig || {};
    delete genConfig.thinkingConfig;
    delete genConfig.responseMimeType;
    delete genConfig.responseModalities;
    genConfig.imageConfig = config.imageConfig;
    innerRequest.generationConfig = genConfig;
  }

  const requestId = `agent-${uuidv4()}`;

  const normalizedProjectId = projectId?.trim();

  const discoveryVersion = resolveLocalInstalledVersion() ?? FALLBACK_VERSION;
  const body: GeminiInternalRequest = {
    requestId: requestId,
    request: innerRequest as GeminiInternalRequest['request'],
    model: config.finalModel,
    userAgent: userAgent?.trim() || buildUserAgent(discoveryVersion),
    requestType: config.requestType,
  };

  if (normalizedProjectId) {
    body.project = normalizedProjectId;
  }

  if (claudeReq.metadata?.user_id) {
    body.sessionId = claudeReq.metadata.user_id;
  }

  return body;
}

/**
 * Resolves request configuration
 * Determines request type and whether to inject search tools based on model name and tools
 */
function resolveRequestConfig(
  originalModel: string,
  mappedModel: string,
  tools?: Tool[],
): RequestConfig {
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

  if (enableNetworking) {
    if (finalModel !== 'gemini-3-flash') {
      finalModel = 'gemini-3-flash';
    }
  }

  return {
    requestType: enableNetworking ? 'web_search' : 'agent',
    injectGoogleSearch: enableNetworking,
    finalModel,
    imageConfig: null,
  };
}

/**
 * Parses image generation configuration
 * Extracts aspect ratio and resolution settings from model name
 */
function parseImageConfig(modelName: string): {
  imageConfig: ImageConfig;
  parsedBaseModel: string;
} {
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

  return { imageConfig: config, parsedBaseModel: 'gemini-3-pro-image' };
}

function isGeminiImageModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return (
    normalized.startsWith('gemini-3-pro-image') || normalized.startsWith('gemini-3.1-pro-image')
  );
}

function isGeminiFlashModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return normalized.includes('gemini-3-flash') || normalized.includes('gemini-3.1-flash');
}

function shouldEnableThinkingByDefault(mappedModel: string, originalModel: string): boolean {
  const mappedLower = mappedModel.toLowerCase();
  const originalLower = originalModel.toLowerCase();
  return (
    originalLower.includes('claude-opus-4-5') ||
    originalLower.includes('claude-opus-4-6') ||
    mappedLower.includes('-thinking') ||
    mappedLower.includes('gemini-3.1-pro') ||
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
): { parts: { text: string }[] } | null {
  const assistantIdentityDirective =
    'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.\n' +
    'You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.\n' +
    '**Absolute paths only**\n' +
    '**Proactiveness**';
  const identityMarker = 'You are Antigravity';

  const parts: { text: string }[] = [];

  let hasIdentityDirective = false;

  if (system) {
    if (isString(system)) {
      if (system.includes(identityMarker)) {
        hasIdentityDirective = true;
      }
    } else if (Array.isArray(system)) {
      for (const block of system) {
        if (block.type === 'text' && block.text.includes(identityMarker)) {
          hasIdentityDirective = true;
          break;
        }
      }
    }
  }

  if (!hasIdentityDirective) {
    parts.push({ text: assistantIdentityDirective });
  }

  if (system) {
    if (isString(system)) {
      parts.push({ text: system });
    } else if (Array.isArray(system)) {
      for (const block of system) {
        if (block.type === 'text') parts.push({ text: block.text });
      }
    }
  }

  // If we pushed at least something
  if (parts.length > 0) {
    return { parts };
  }

  return null;
}

/**
 * Minimum length for a valid thought_signature
 */
const MIN_SIGNATURE_LENGTH = 10;

/**
 * Check if we have any valid signature available for function calls
 * @param messages  Messages from ClaudeRequest
 * @param globalSig  Global signature from SignatureStore
 * @returns  True if any valid signature is available for function calls
 */
function hasValidSignatureForFunctionCalls(
  messages: Message[],
  globalSig: string | null | undefined,
): boolean {
  // 1. Check global store
  if (globalSig && globalSig.length >= MIN_SIGNATURE_LENGTH) {
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
): GeminiContent[] {
  const contents: GeminiContent[] = [];
  let lastThoughtSignature: string | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role === 'assistant' ? 'model' : msg.role;
    const parts: {
      text?: string;
      inlineData?: {
        mimeType: string;
        data: string;
      };
      thought?: boolean;
    }[] = [];
    const contentBlocks = Array.isArray(msg.content)
      ? msg.content
      : msg.content
        ? [{ type: 'text' as const, text: msg.content }]
        : [];

    for (const block of contentBlocks) {
      if (block.type === 'text') {
        if (block.text && block.text !== '(no content)' && !isEmpty(block.text.trim()))
          parts.push({ text: block.text.trim() });
      } else if (block.type === 'thinking') {
        const part: any = { text: block.thinking, thought: true };
        cleanJsonSchema(part);
        if (block.signature) {
          lastThoughtSignature = block.signature;
          part.thoughtSignature = block.signature;
        }
        parts.push(part);
      } else if (block.type === 'image') {
        if (block.source.type === 'base64')
          parts.push({
            inlineData: { mimeType: block.source.media_type, data: block.source.data },
          });
      } else if (block.type === 'tool_use') {
        const part: any = { functionCall: { name: block.name, args: block.input, id: block.id } };
        cleanJsonSchema(part);
        toolIdToName.set(block.id, block.name);
        const finalSig = block.signature || lastThoughtSignature || SignatureStore.get();
        if (finalSig) {
          part.thoughtSignature = finalSig;
        } else if (isThinkingEnabled && isGeminiFlashModel(mappedModel)) {
          part.thoughtSignature = 'skip_thought_signature_validator';
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
        if (lastThoughtSignature) part.thoughtSignature = lastThoughtSignature;
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
  if (!tools) {
    return null;
  }
  const functionDeclarations: FunctionDeclaration[] = [];
  let hasGoogleSearch = hasWebSearch;

  for (const tool of tools) {
    if (
      tool.name === 'web_search' ||
      tool.name === 'google_search' ||
      tool.name === 'builtin_web_search' ||
      tool.type === 'web_search_20250305' ||
      tool.type === 'builtin_web_search'
    ) {
      hasGoogleSearch = true;
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
