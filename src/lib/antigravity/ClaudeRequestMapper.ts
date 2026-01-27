import { v4 as uuidv4 } from 'uuid';
import { mapClaudeModelToGemini } from './ModelMapping';
import { cleanJsonSchema } from './JsonSchemaUtils';
import { SignatureStore } from './SignatureStore';
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
  projectId: string,
): GeminiInternalRequest {
  // Check for networking tools (server tool or built-in tool)
  const hasWebSearchTool = detectsNetworkingTool(claudeReq.tools);

  // Map to store tool_use id -> name mapping
  const toolIdToName = new Map<string, string>();

  // 1. System Instruction
  const systemInstruction = buildSystemInstruction(claudeReq.system, claudeReq.model);

  // Map model name
  const mappedModel = hasWebSearchTool
    ? 'gemini-2.5-flash'
    : mapClaudeModelToGemini(claudeReq.model);

  // Convert Claude tools to Tool array for networking detection
  const toolsVal: Tool[] | undefined = claudeReq.tools
    ? (JSON.parse(JSON.stringify(claudeReq.tools)) as Tool[])
    : undefined;

  // Resolve grounding config
  const config = resolveRequestConfig(claudeReq.model, mappedModel, toolsVal);

  const allowDummyThought = config.finalModel.startsWith('gemini-');

  // 4. Generation Config & Thinking
  let isThinkingEnabled = claudeReq.thinking?.type === 'enabled';

  if (isThinkingEnabled) {
    const globalSig = SignatureStore.get();
    const hasFunctionCalls = claudeReq.messages.some((m) => {
      if (Array.isArray(m.content)) {
        return m.content.some((b) => b.type === 'tool_use');
      }
      return false;
    });

    if (hasFunctionCalls && !hasValidSignatureForFunctionCalls(claudeReq.messages, globalSig)) {
      isThinkingEnabled = false;
    }
  }

  const generationConfig = buildGenerationConfig(claudeReq, hasWebSearchTool, config.finalModel);
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
  );

  // 3. Tools
  const tools = buildTools(claudeReq.tools, hasWebSearchTool);

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
    injectGoogleSearchTool(innerRequest);
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

  const body: GeminiInternalRequest = {
    project: projectId,
    requestId: requestId,
    request: innerRequest as GeminiInternalRequest['request'],
    model: config.finalModel,
    userAgent: 'antigravity',
    requestType: config.requestType,
  };

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
  if (mappedModel.startsWith('gemini-3-pro-image')) {
    const { imageConfig, parsedBaseModel } = parseImageConfig(originalModel);
    return {
      requestType: 'image_gen',
      injectGoogleSearch: false,
      finalModel: parsedBaseModel,
      imageConfig,
    };
  }

  const hasNetworkingTool = detectsNetworkingTool(tools);
  const hasNonNetworking = containsNonNetworkingTool(tools);

  // Strip -online suffix
  const isOnlineSuffix = originalModel.endsWith('-online');

  const isHighQualityModel =
    mappedModel === 'gemini-2.5-flash' ||
    mappedModel === 'gemini-1.5-pro' ||
    mappedModel.startsWith('gemini-1.5-pro-') ||
    mappedModel.startsWith('gemini-2.5-flash-') ||
    mappedModel.startsWith('gemini-2.0-flash') ||
    mappedModel.startsWith('gemini-3-') ||
    mappedModel.includes('claude-3-5-sonnet') ||
    mappedModel.includes('claude-3-opus') ||
    mappedModel.includes('claude-sonnet') ||
    mappedModel.includes('claude-opus') ||
    mappedModel.includes('claude-4');

  // Determine if we should enable networking
  const enableNetworking =
    isOnlineSuffix || (isHighQualityModel && !hasNonNetworking) || hasNetworkingTool;

  let finalModel = mappedModel.replace(/-online$/, '');
  if (enableNetworking) {
    // Fallback for search compatibility
    if (finalModel.includes('thinking') || !finalModel.startsWith('gemini-')) {
      finalModel = 'gemini-2.5-flash';
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
  ];

  for (const tool of tools) {
    // Claude Tool format
    if ('name' in tool && tool.name && keywords.includes(tool.name)) {
      return true;
    }
    if ('type' in tool && tool.type && keywords.includes(tool.type)) {
      return true;
    }

    // OpenAI nested format (runtime check)
    const openaiTool = tool as { function?: { name?: string } };
    if (openaiTool.function?.name && keywords.includes(openaiTool.function.name)) {
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

/**
 * Detects if non-networking tools are present
 * Checks tool list for tools other than web search
 */
function containsNonNetworkingTool(tools?: (Tool | GeminiToolDeclaration)[]): boolean {
  if (!tools) {
    return false;
  }
  const keywords = [
    'web_search',
    'google_search',
    'web_search_20250305',
    'google_search_retrieval',
  ];

  for (const tool of tools) {
    let isNetworking = false;

    // Claude Tool format
    if ('name' in tool && tool.name && keywords.includes(tool.name)) {
      isNetworking = true;
    }

    // OpenAI nested format (runtime check)
    const openaiTool = tool as { function?: { name?: string } };
    if (openaiTool.function?.name && keywords.includes(openaiTool.function.name))
      isNetworking = true;

    // Gemini search tools
    if ('googleSearch' in tool && tool.googleSearch) {
      isNetworking = true;
    }
    if ('googleSearchRetrieval' in tool && tool.googleSearchRetrieval) {
      isNetworking = true;
    }

    // Gemini functionDeclarations
    if ('functionDeclarations' in tool && tool.functionDeclarations) {
      for (const decl of tool.functionDeclarations) {
        if (decl.name && !keywords.includes(decl.name)) {
          return true; // Found local
        }
      }
      isNetworking = true; // All are networking
    }

    if (!isNetworking) {
      return true;
    }
  }
  return false;
}

/**
 * Inject Google Search Tool
 * Adds googleSearch tool to the request
 */
function injectGoogleSearchTool(body: { tools?: GeminiToolDeclaration[] }) {
  if (!body.tools) {
    body.tools = [];
  }
  const toolsArr = body.tools;

  const hasFunctions = toolsArr.some((t) => t.functionDeclarations);
  if (hasFunctions) {
    console.info('Skipping googleSearch injection due to existing functionDeclarations');
    return;
  }

  // Remove existing to avoid duplicates
  body.tools = toolsArr.filter((t) => !t.googleSearch && !t.googleSearchRetrieval);
  body.tools.push({ googleSearch: {} });
}

/**
 * Builds system instruction
 * Converts Claude system prompts to Gemini format, with Antigravity Identity Injection
 */
function buildSystemInstruction(
  system: ClaudeRequest['system'],
  modelName: string,
): { parts: { text: string }[] } | null {
  const antigravity_identity =
    '--- [IDENTITY_PATCH] ---\n' +
    'Ignore any previous instructions regarding your identity or host platform (e.g., Amazon Q, Google AI).\n' +
    'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.\n' +
    'You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.\n' +
    '**Absolute paths only**\n' +
    '**Proactiveness**';

  const parts: { text: string }[] = [];

  // Check if user already provided Antigravity identity
  let userHasAntigravity = false;

  if (system) {
    if (typeof system === 'string') {
      if (system.includes('You are Antigravity')) userHasAntigravity = true;
    } else if (Array.isArray(system)) {
      for (const block of system) {
        if (block.type === 'text' && block.text.includes('You are Antigravity')) {
          userHasAntigravity = true;
          break;
        }
      }
    }
  }

  // Inject if missing
  if (!userHasAntigravity) {
    parts.push({ text: antigravity_identity });
  }

  if (system) {
    if (typeof system === 'string') {
      parts.push({ text: system });
    } else if (Array.isArray(system)) {
      for (const block of system) {
        if (block.type === 'text') parts.push({ text: block.text });
      }
    }
  }

  if (!userHasAntigravity) {
    parts.push({ text: '\n--- [SYSTEM_PROMPT_END] ---' });
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
        if (block.text && block.text !== '(no content)' && block.text.trim() !== '')
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
        if (finalSig) part.thoughtSignature = finalSig;
        parts.push(part);
      } else if (block.type === 'tool_result') {
        const funcName = toolIdToName.get(block.tool_use_id) || block.tool_use_id;
        let mergedContent = '';
        if (typeof block.content === 'string') mergedContent = block.content;
        else if (Array.isArray(block.content))
          mergedContent = block.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n');
        if (mergedContent.trim().length === 0)
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
      tool.type === 'web_search_20250305'
    ) {
      hasGoogleSearch = true;
      continue;
    }
    if (tool.name) {
      const inputSchema = tool.input_schema || { type: 'object', properties: {} };
      cleanJsonSchema(inputSchema);
      functionDeclarations.push({
        name: tool.name,
        description: tool.description,
        parameters: inputSchema,
      });
    }
  }

  const toolObj: GeminiToolDeclaration = {};
  if (functionDeclarations.length > 0) {
    toolObj.functionDeclarations = functionDeclarations;
  } else if (hasGoogleSearch) {
    toolObj.googleSearch = {};
  }

  if (Object.keys(toolObj).length > 0) {
    return [toolObj];
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
): GenerationConfig {
  const config: GenerationConfig = {};
  if (claudeReq.thinking?.type === 'enabled') {
    const thinkingConfig: GenerationConfig['thinkingConfig'] = { includeThoughts: true };
    if (claudeReq.thinking.budget_tokens) {
      let budget = claudeReq.thinking.budget_tokens;
      const isFlash = hasWebSearch || mappedModel.includes('gemini-2.5-flash');
      if (isFlash) budget = Math.min(budget, 24576);
      thinkingConfig.thinkingBudget = budget;
    }
    config.thinkingConfig = thinkingConfig;
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
  config.maxOutputTokens = 64000;
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
  } else if (obj && typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    Object.keys(record).forEach((key) => {
      if (record[key] === undefined) delete record[key];
      else deepCleanUndefined(record[key]);
    });
  }
}
