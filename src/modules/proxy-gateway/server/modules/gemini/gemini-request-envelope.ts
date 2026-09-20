import { randomUUID } from 'node:crypto';
import { isString } from 'lodash-es';
import type { GeminiRequest } from '../../common/interfaces/request-interfaces';
import type { GeminiInternalRequest } from '../../../antigravity/types';
import { normalizeGeminiToolConfigAliases } from '../../../antigravity/GeminiToolConfigCompat';
import { injectPlaceholderSignaturesForModel } from '../../../antigravity/ThoughtSignatureCompat';
import { requiresToolQuotaRoute } from '../../../antigravity/ToolQuotaRoute';

export function toInternalGeminiRequest(
  request: GeminiRequest,
  model: string,
): GeminiInternalRequest['request'] {
  return {
    contents: injectPlaceholderSignaturesForModel(request.contents, model),
    generationConfig: request.generationConfig,
    safetySettings: request.safetySettings,
    tools: request.tools,
    ...normalizeGeminiToolConfigAliases(request),
    systemInstruction: request.systemInstruction
      ? {
          parts: request.systemInstruction.parts
            .filter((part): part is { text: string } => isString(part.text))
            .map((part) => ({ text: part.text })),
        }
      : undefined,
  };
}

/** Shared envelope for the native Gemini endpoint and the main-process warmup adapter. */
export function createGeminiRequestEnvelope(
  model: string,
  request: GeminiRequest,
  projectId: string | undefined,
  requestType: string,
  userAgent: string,
  requestId = `agent/${Date.now()}/${randomUUID().replaceAll('-', '').slice(0, 8)}`,
): GeminiInternalRequest {
  const project = projectId?.trim();
  const internalRequest = toInternalGeminiRequest(request, model);
  const providerRequestType =
    requestType === 'image_gen'
      ? 'image_gen'
      : requiresToolQuotaRoute({ tools: internalRequest.tools, contents: internalRequest.contents })
        ? 'agent'
        : undefined;
  return {
    requestId,
    request: internalRequest,
    model,
    userAgent,
    ...(project ? { project } : {}),
    ...(providerRequestType ? { requestType: providerRequestType } : {}),
    ...(providerRequestType === 'agent' ? { enabledCreditTypes: ['GOOGLE_ONE_AI'] } : {}),
  };
}
