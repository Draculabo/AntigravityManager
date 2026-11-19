import { v4 as uuidv4 } from 'uuid';
import type { ImageSchedulerConfig } from '@/modules/config/types';
import { getServerConfig } from '@/server/server-config';
import { logger } from '@/shared/logging/logger';
import { prepareGoogleGenerationContents } from '../../../server/gateway/common/generation-history';
import { isDisabledThinkingEffort } from '../../../server/gateway/common/model-effort';
import {
  buildUserAgent,
  FALLBACK_VERSION,
  resolveLocalInstalledVersion,
} from '@/server/gateway/common/utils/request-user-agent';
import {
  buildGenerationConfig,
  resolveRequestConfig,
  shouldEnableThinkingByDefault,
  targetModelSupportsThinking,
  type ResolvedRequestConfig,
} from './AntigravityModelRequest';
import {
  buildContents,
  buildSystemInstruction,
  extractEmbeddedSystemMessages,
  hasValidSignatureForFunctionCalls,
} from './AntigravityRequestContents';
import {
  buildTools,
  detectsNetworkingTool,
  injectGoogleSearchTool,
} from './AntigravityRequestTools';
import type { AntigravityGenerationInput } from './generation-input';
import { toSnakeToolConfig } from './GeminiToolConfigCompat';
import {
  IMAGE_GENERATION_SAFETY_SETTINGS,
  type ImageGenerationConfigInput,
} from './ImageGenerationConfig';
import { applyGeminiMediaSendWindow } from './MediaSendWindowApply';
import { mapClaudeModelToGemini, normalizeGeminiModelAlias } from './ModelMapping';
import { SignatureStore } from './SignatureStore';
import { modelKeepsThinkingWithoutSignature } from './ThoughtSignatureCompat';
import { buildToolConfig } from './ToolChoiceCompat';
import { requiresToolQuotaRoute } from './ToolQuotaRoute';
import type { GeminiInternalRequest, GeminiRequest, SafetySetting } from './types';

export interface AntigravityRequestOptions {
  projectId?: string;
  userAgent?: string;
  resolvedModel?: string;
  omitToolsWithResponseSchema?: boolean;
  /** Undefined resolves current configuration for direct mapper/count callers; null pins disabled. */
  globalSystemPrompt?: string | null;
  schemasPrepared?: boolean;
  cacheSchemas?: boolean;
  imageRequest?: ImageGenerationConfigInput;
  signatureTargetFamily?: string | null;
  signatureTargetFamilyModel?: string | null;
  mediaWindow?: ImageSchedulerConfig;
  /** Responses protects the latest user request together with its following tool round. */
  mediaWindowProtectLatestUserTurn?: true;
  purpose?: 'generation' | 'count';
}

const SAFETY_SETTINGS: SafetySetting[] = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
];

export function buildAntigravityGenerationRequest(
  input: AntigravityGenerationInput,
  options: AntigravityRequestOptions = {},
): GeminiInternalRequest {
  const { projectId, userAgent, resolvedModel } = options;
  const { extraSystemMessages, messages } = extractEmbeddedSystemMessages(input.messages);
  const { signatureSessionKey } = input;
  const toolConfig = buildToolConfig(input.toolChoice, input.tools ?? []);
  // Check for networking tools (server tool or built-in tool)
  const hasWebSearchTool = detectsNetworkingTool(input.tools);

  // 1. System Instruction
  const systemInstruction = buildSystemInstruction(
    input.system,
    extraSystemMessages,
    input.tools,
    options.globalSystemPrompt,
  );

  // Map model name
  const mappedModel = resolvedModel
    ? resolvedModel.toLowerCase().includes('-image')
      ? resolvedModel
      : normalizeGeminiModelAlias(resolvedModel)
    : mapClaudeModelToGemini(input.model);

  const normalizedTools = structuredClone(input.tools);

  // Resolve grounding config
  const requestConfig = resolveRequestConfig(
    input.model,
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
  const clientControlled = getServerConfig()?.thinking_budget?.control_source === 'client';
  const clientEffort = input.thinking?.effort ?? input.outputEffort;
  const clientDisabled =
    clientControlled &&
    (['disabled', 'off', 'false', '0'].includes((input.thinking?.type ?? '').toLowerCase()) ||
      input.thinking?.budgetTokens === 0 ||
      isDisabledThinkingEffort(clientEffort));
  const thinkingType = (input.thinking?.type ?? '').toLowerCase();
  const autoThinkingEnabled =
    !input.thinking && shouldEnableThinkingByDefault(requestConfig.finalModel, input.model);
  let isThinkingEnabled =
    !clientDisabled &&
    (thinkingType === 'enabled' ||
      thinkingType === 'adaptive' ||
      autoThinkingEnabled ||
      clientControlled);

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
    input,
    hasWebSearchTool,
    requestConfig.finalModel,
    isThinkingEnabled,
    options.schemasPrepared === true,
  );
  // Update thinking config based on the final decision
  if (!isThinkingEnabled && generationConfig.thinkingConfig) {
    delete generationConfig.thinkingConfig;
  }
  if (clientControlled && !isThinkingEnabled) {
    // Preserve the mapper's capability/signature decision through final planning.
    generationConfig.thinkingConfig = { includeThoughts: false, thinkingBudget: 0 };
  }

  // 2. Contents (Messages)
  const protectedMediaContents = options.mediaWindowProtectLatestUserTurn
    ? new Set<number>()
    : undefined;
  const mappedContents = buildContents(
    messages,
    isThinkingEnabled,
    requestConfig.finalModel,
    signatureSessionKey,
    options.signatureTargetFamily,
    options.signatureTargetFamilyModel,
    protectedMediaContents,
  );
  if (protectedMediaContents) {
    // Resolve protection before generation cleanup can remove empty message positions.
    applyGeminiMediaSendWindow(mappedContents, options.mediaWindow, protectedMediaContents);
  }
  const contents =
    options.purpose === 'count'
      ? mappedContents
      : prepareGoogleGenerationContents(mappedContents, requestConfig.finalModel);
  if (!protectedMediaContents) {
    applyGeminiMediaSendWindow(contents, options.mediaWindow);
  }

  // 3. Tools
  const tools = buildTools(input.tools, hasWebSearchTool, requestConfig.finalModel, options);

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
  }

  // Inject googleSearch tool if needed (and not already done by buildTools)
  if (requestConfig.injectGoogleSearch && !hasWebSearchTool) {
    injectGoogleSearchTool(innerRequest, requestConfig.finalModel);
  }
  if (innerRequest.tools && innerRequest.toolConfig === undefined) {
    innerRequest.toolConfig = toolConfig;
    innerRequest.tool_config = toSnakeToolConfig(toolConfig);
  }

  if (options.omitToolsWithResponseSchema && generationConfig?.responseSchema) {
    delete innerRequest.tools;
    delete innerRequest.toolConfig;
    delete innerRequest.tool_config;
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

function createOfficialRequestId(): string {
  const timestampMs = Date.now();
  const randomHex = uuidv4().replace(/-/g, '').slice(0, 8);
  return `agent/${timestampMs}/${randomHex}`;
}
